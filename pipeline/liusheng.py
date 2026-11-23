"""Local, episode-relative ASR using Daily Recall's Voxt and CAM++ components."""

import fcntl
import hashlib
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import wave
from collections import Counter
from functools import lru_cache
from pathlib import Path


SAMPLE_RATE = 16000
PROFILE_KIND = 'beiershuo-host-campplus-v1'
CACHE_VERSION = 1
MIN_REFERENCE_SECONDS = 2.0
MAX_REFERENCE_SECONDS = 20.0
HOST_MIN = 0.55
MIN_REFERENCE_MATCH = 0.45
OTHER_MAX = 0.32
MODEL_DIRECTORY = Path.home() / 'Library/Application Support/留声/models'
DEFAULT_RECALL_ROOT = Path.home() / 'Projects/daily-recall'
_IMPORT_LOCK = threading.Lock()


def _isolated_path(value):
    path = Path(value).expanduser().resolve()
    personal_libraries = [Path.home() / 'Documents/每日录音']
    if os.environ.get('RECALL_LIBRARY'):
        personal_libraries.append(Path(os.environ['RECALL_LIBRARY']).expanduser())
    for library in personal_libraries:
        if library.resolve() in (path, *path.parents):
            raise ValueError('Use a separate podcast source, workspace and host profile outside the 留声 library.')
    return path


def _file_sha256(path):
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def _read_json(path):
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()


def _load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, str(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=None)
def _recall_modules(root):
    folder = root / 'pipeline'
    required = ('common.py', 'glossary.py', 'transcribe.py', 'speakers.py')
    for filename in required:
        if not (folder / filename).is_file():
            raise RuntimeError('Daily Recall source missing: %s. Set BEIERSHUO_RECALL_ROOT.' % (folder / filename))
    # Daily Recall scripts use sibling imports by bare name. Bind just these
    # dependencies while loading their reusable functions.
    with _IMPORT_LOCK:
        previous = {name: sys.modules.get(name) for name in ('common', 'glossary')}
        search_path = sys.path[:]
        try:
            common = _load_module('_beiershuo_recall_common', folder / 'common.py')
            sys.modules['common'] = common
            sys.modules['glossary'] = _load_module('_beiershuo_recall_glossary', folder / 'glossary.py')
            speech = _load_module('_beiershuo_recall_transcribe', folder / 'transcribe.py')
            voices = _load_module('_beiershuo_recall_speakers', folder / 'speakers.py')
        finally:
            sys.path[:] = search_path
            for name, module in previous.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
    return common, speech, voices


def _dependencies(recall_root, embedding_model):
    root = Path(recall_root or os.environ.get('BEIERSHUO_RECALL_ROOT', DEFAULT_RECALL_ROOT)).expanduser().resolve()
    common, speech, voices = _recall_modules(root)
    cam = Path(embedding_model or os.environ.get('BEIERSHUO_CAM_MODEL', MODEL_DIRECTORY / 'campplus.onnx'))
    cam = cam.expanduser().resolve()
    if not cam.is_file():
        raise RuntimeError('CAM++ model missing: %s. Set BEIERSHUO_CAM_MODEL to the local ONNX file.' % cam)
    if not shutil.which('ffmpeg'):
        raise RuntimeError('Install ffmpeg on PATH to decode episode audio.')
    try:
        import numpy
        import sherpa_onnx
    except ImportError as error:
        raise RuntimeError('Install numpy and sherpa-onnx in the Python environment running this pipeline.') from error
    return common, speech, voices, cam, numpy, sherpa_onnx


def _validate_media(source):
    if not source.is_file():
        raise FileNotFoundError('Episode audio file missing: %s' % source)


def _decode(source, target):
    temporary = target.with_name('decode.tmp.wav')
    try:
        result = subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(source), '-map', '0:a:0',
            '-ac', '1', '-ar', str(SAMPLE_RATE), '-c:a', 'pcm_s16le', str(temporary),
        ], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('ffmpeg could not decode episode audio: %s' % result.stderr.strip())
        _wav_info(temporary)
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()


def _wav_info(path):
    with wave.open(str(path), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2) or not wav.getnframes():
            raise ValueError('Expected non-empty 16 kHz mono PCM audio: %s' % path)
        return wav.getnframes()


def _sample_embedding(voices, model, samples, np):
    found = voices.segment_features(model, samples, {'start': 0, 'end': len(samples) / SAMPLE_RATE})
    if found is None:
        return None
    vector, loudness, _ = found
    if loudness < -55 or not np.isfinite(vector).all() or float(np.linalg.norm(vector)) < 0.9:
        return None
    return vector


def _embedding_config(sherpa, model):
    return sherpa.SpeakerEmbeddingExtractorConfig(model=str(model), num_threads=4)


def _load_profile(path, cam_hash, num_dimensions, np):
    profile = _read_json(path)
    if not isinstance(profile, dict) or profile.get('kind') != PROFILE_KIND:
        raise ValueError('Use a separately enrolled 贝儿说 host profile: %s' % path)
    if profile.get('modelRevision') != cam_hash:
        raise ValueError('Host profile CAM++ model changed. Enroll the host again with the current model.')
    vector = np.asarray(profile.get('vector'), dtype=np.float32)
    if vector.shape != (num_dimensions,) or not np.isfinite(vector).all() or float(np.linalg.norm(vector)) < 0.9:
        raise ValueError('Host profile contains an invalid CAM++ embedding: %s' % path)
    return vector / np.linalg.norm(vector)


def enroll(samples, profile_path, *, recall_root=None, embedding_model=None):
    """Create a host-only profile from at least three human-confirmed clean speech spans."""
    path = _isolated_path(profile_path)
    if path.exists():
        existing = _read_json(path)
        if not isinstance(existing, dict) or existing.get('kind') != PROFILE_KIND:
            raise ValueError('Refusing to replace an existing non-贝儿说 voice profile: %s' % path)
    references = []
    for raw_source, raw_start, raw_end in samples:
        source = _isolated_path(raw_source)
        _validate_media(source)
        start, end = float(raw_start), float(raw_end)
        if not (math.isfinite(start) and math.isfinite(end) and start >= 0 and
                MIN_REFERENCE_SECONDS <= end - start <= MAX_REFERENCE_SECONDS):
            raise ValueError('Each enrollment reference needs 2–20 seconds of clean speech at a non-negative offset.')
        references.append((source, start, end))
    if len(references) < 3:
        raise ValueError('Choose at least three non-overlapping references of the confirmed host speaking.')
    ordered = sorted(references)
    for (source, _, end), (following_source, following_start, _) in zip(ordered, ordered[1:]):
        if source == following_source and end > following_start:
            raise ValueError('Enrollment references must not overlap.')

    _, _, voices, cam, np, sherpa = _dependencies(recall_root, embedding_model)
    model = sherpa.SpeakerEmbeddingExtractor(_embedding_config(sherpa, cam))
    vectors, provenance = [], []
    with tempfile.TemporaryDirectory(prefix='beiershuo-enrollment-') as scratch:
        for source, start, end in references:
            result = subprocess.run([
                'ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-i', str(source), '-t', str(end - start),
                '-map', '0:a:0', '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'f32le', '-',
            ], capture_output=True)
            if result.returncode:
                raise RuntimeError('Cannot decode enrollment reference: %s' % result.stderr.decode(errors='replace').strip())
            decoded = np.frombuffer(result.stdout, dtype='<f4')
            if len(decoded) < round((end - start) * SAMPLE_RATE) - 1:
                raise ValueError('Enrollment range goes beyond the source audio: %s' % source)
            vector = _sample_embedding(voices, model, decoded, np)
            if vector is None:
                raise ValueError('Enrollment range has no usable speech: %s at %.3fs' % (source, start))
            vectors.append(vector)
            provenance.append({'audioRevision': 'sha256:' + _file_sha256(source), 'startSec': start, 'endSec': end})
    similarities = [float(v @ w) for i, v in enumerate(vectors) for w in vectors[i + 1:]]
    if min(similarities) < MIN_REFERENCE_MATCH:
        raise ValueError('Enrollment references sound inconsistent. Choose clean spans of only the confirmed host '
                         '(minimum pairwise similarity %.3f, needs %.2f).' % (min(similarities), MIN_REFERENCE_MATCH))
    centre = np.mean(vectors, axis=0)
    profile = {'kind': PROFILE_KIND, 'modelRevision': _file_sha256(cam), 'references': provenance,
               'vector': (centre / np.linalg.norm(centre)).tolist()}
    _write_json(path, profile)
    return {'profilePath': str(path), 'references': len(references), 'minimumSimilarity': round(min(similarities), 3)}


def _diarize(samples, sherpa, cam, segmentation_model):
    pyannote = sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation_model))
    segmentation = sherpa.OfflineSpeakerSegmentationModelConfig(pyannote=pyannote, num_threads=4)
    config = sherpa.OfflineSpeakerDiarizationConfig(
        segmentation=segmentation, embedding=_embedding_config(sherpa, cam),
        clustering=sherpa.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    model = sherpa.OfflineSpeakerDiarization(config)
    return [[max(0, round(turn.start * SAMPLE_RATE)), min(len(samples), round(turn.end * SAMPLE_RATE)), turn.speaker]
            for turn in model.process(samples).sort_by_start_time()]


def _regions(diarization, frames):
    """Partition into disjoint, absolute sample ranges carrying all active speakers."""
    events = {0: Counter(), frames: Counter()}
    for start, end, speaker in diarization:
        start, end = max(0, start), min(frames, end)
        if end > start:
            events.setdefault(start, Counter())[speaker] += 1
            events.setdefault(end, Counter())[speaker] -= 1
    active, regions = Counter(), []
    boundaries = sorted(events)
    for start, end in zip(boundaries, boundaries[1:]):
        active.update(events[start])
        speakers = tuple(sorted(speaker for speaker, count in active.items() if count > 0))
        if regions and regions[-1][2] == speakers:
            regions[-1] = (regions[-1][0], end, speakers)
        else:
            regions.append((start, end, speakers))
    return regions


def _plan_regions(speech, wav, vad, diarization, folder):
    plan, vid = [], 0
    for start, end, speakers in _regions(diarization, wav.getnframes()):
        while vid < len(vad) and vad[vid][1] <= start:
            vid += 1
        index, clipped = vid, []
        while index < len(vad) and vad[index][0] < end:
            left, right = vad[index]
            if min(end, right) > max(start, left):
                clipped.append([max(start, left), min(end, right)])
            index += 1
        chunks = speech.write_chunks(wav, speech.plan_chunks(wav, clipped), folder)
        if chunks:
            plan.append((start, end, speakers, clipped, chunks))
    return plan


def _turn_embedding(voices, model, samples, clipped, np):
    parts = [samples[start:end] for start, end in clipped]
    voiced = np.concatenate(parts)
    if len(voiced) < MIN_REFERENCE_SECONDS * SAMPLE_RATE:
        return None
    limit = 12 * SAMPLE_RATE
    if len(voiced) > limit:
        # Sample the turn's early, middle and late voicing with equal weight.
        step = limit // 3
        mid = (len(voiced) - step) // 2
        voiced = np.concatenate([voiced[:step], voiced[mid:mid + step], voiced[-step:]])
    return _sample_embedding(voices, model, voiced, np)


def _speaker_label(speakers, embedding, profile):
    if len(speakers) != 1 or embedding is None or profile is None:
        return 'unsure', None
    score = float(embedding @ profile)
    label = 'beier' if score >= HOST_MIN else 'other' if score <= OTHER_MAX else 'unsure'
    return label, round(score, 4)


def _cache_key(root, common, cam, segmentation, sherpa):
    model_paths = [cam, segmentation]
    for path in (common.ASR_MODEL, common.VAD_MODEL):
        model_paths.extend(sorted(entry for entry in path.iterdir() if entry.is_file()))
    model_paths.extend(common.VOXT_BIN / name for name in ('qwen3_asr_server', 'qwen3_asr_transcribe'))
    module_hashes = [_file_sha256(root / 'pipeline' / file) for file in ('common.py', 'transcribe.py', 'speakers.py')]
    # Large MLX weights are local installed assets. Track their identity via
    # installed path, size and nanosecond mtime without rehashing gigabytes per run.
    model_versions = [(str(path), path.stat().st_size, path.stat().st_mtime_ns) for path in model_paths]
    payload = (CACHE_VERSION, sherpa.__version__, module_hashes, model_versions)
    return hashlib.sha256(json.dumps(payload).encode()).hexdigest()[:16]


def _repair_asr_checkpoint(path):
    if not path.exists():
        return
    original = path.read_text(encoding='utf-8', errors='replace')
    kept = []
    for line in original.splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get('file'), str) and isinstance(row.get('text'), str):
                kept.append(json.dumps(row, ensure_ascii=False) + '\n')
        except ValueError:
            pass
    repaired = ''.join(kept)
    if repaired != original:
        temporary = path.with_suffix('.tmp')
        temporary.write_text(repaired, encoding='utf-8')
        temporary.replace(path)


def transcribe(source, work_dir, profile_path=None, *, recall_root=None, diarization_model=None, embedding_model=None):
    """Return local ASR segments on the original episode's timeline, with speaker confidence."""
    source, work_dir = _isolated_path(source), _isolated_path(work_dir)
    _validate_media(source)
    profile_path = _isolated_path(profile_path) if profile_path is not None else None
    root = Path(recall_root or os.environ.get('BEIERSHUO_RECALL_ROOT', DEFAULT_RECALL_ROOT)).expanduser().resolve()
    common, speech, voices, cam, np, sherpa = _dependencies(root, embedding_model)
    segmentation = diarization_model or os.environ.get('BEIERSHUO_DIARIZATION_MODEL', MODEL_DIRECTORY / 'pyannote-segmentation-3-0.onnx')
    segmentation = Path(segmentation).expanduser().resolve()
    if not segmentation.is_file():
        raise RuntimeError('Pyannote segmentation model missing: %s. Set BEIERSHUO_DIARIZATION_MODEL.' % segmentation)
    for command in ('curl',):
        if not shutil.which(command):
            raise RuntimeError('%s must be on PATH for the Daily Recall Voxt VAD client.' % command)
    for directory in (common.ASR_MODEL, common.VAD_MODEL):
        if not directory.is_dir():
            raise RuntimeError('Voxt model missing: %s. Install Voxt and download the models.' % directory)
    for name in ('qwen3_asr_server', 'qwen3_asr_transcribe'):
        executable = common.VOXT_BIN / name
        if not os.access(executable, os.X_OK):
            raise RuntimeError('Voxt executable missing or non-executable: %s' % executable)

    embedder = sherpa.SpeakerEmbeddingExtractor(_embedding_config(sherpa, cam)) if profile_path else None
    profile = _load_profile(profile_path, _file_sha256(cam), embedder.dim, np) if profile_path else None
    revision = _file_sha256(source)
    scratch = work_dir / revision / _cache_key(root, common, cam, segmentation, sherpa)
    scratch.mkdir(parents=True, exist_ok=True)
    with (scratch / 'transcribe.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _transcribe_locked(source, scratch, revision, common, speech, voices, cam, segmentation,
                                  np, sherpa, embedder, profile)


def _transcribe_locked(source, scratch, revision, common, speech, voices, cam, segmentation, np, sherpa,
                       embedder, profile):
    wav_path, vad_path, diar_path = (scratch / name for name in ('audio_16k.wav', 'vad.json', 'diarization.json'))
    if not wav_path.exists():
        _decode(source, wav_path)
    frames = _wav_info(wav_path)
    if vad_path.exists():
        vad = _read_json(vad_path)
    else:
        vad_server = speech.VadServer(scratch / 'vad.log')
        try:
            vad = sorted(vad_server.speech(wav_path))
        finally:
            vad_server.close()
        _write_json(vad_path, vad)
    if not vad:
        return {'audioRevision': 'sha256:' + revision, 'durationSec': frames / SAMPLE_RATE, 'segments': []}

    samples = None
    if not diar_path.exists() or embedder is not None:
        with wave.open(str(wav_path), 'rb') as wav:
            samples = np.frombuffer(wav.readframes(frames), dtype='<i2').astype(np.float32) / 32768
    if diar_path.exists():
        diarization = _read_json(diar_path)
    else:
        diarization = _diarize(samples, sherpa, cam, segmentation)
        _write_json(diar_path, diarization)
    with wave.open(str(wav_path), 'rb') as wav:
        regions = _plan_regions(speech, wav, vad, diarization, scratch / 'chunks')
    plan = [chunk for _, _, _, _, chunks in regions for chunk in chunks]
    checkpoint = scratch / 'asr.jsonl'
    if plan:
        _repair_asr_checkpoint(checkpoint)
        rows = speech.run_asr(plan, checkpoint, scratch / 'asr.log', 'Chinese')
    else:
        rows = {}

    segments = []
    for _, _, speakers, clipped, chunks in regions:
        embedding = _turn_embedding(voices, embedder, samples, clipped, np) if embedder and len(speakers) == 1 else None
        label, similarity = _speaker_label(speakers, embedding, profile)
        for chunk in chunks:
            row = rows.get(chunk['file'])
            if not row or not isinstance(row.get('text'), str):
                raise RuntimeError('Voxt did not return a complete ASR record for %s. See %s.' %
                                   (chunk['file'], scratch / 'asr.log'))
            text = row['text'].strip()
            if text:
                segments.append({'startSec': chunk['start'], 'endSec': chunk['end'], 'text': text,
                                 'speaker': label, 'speakerSimilarity': similarity, 'overlap': len(speakers) > 1,
                                 'finishReason': row.get('finish_reason'), 'speechRanges': chunk['speech']})
    return {'audioRevision': 'sha256:' + revision, 'durationSec': frames / SAMPLE_RATE, 'segments': segments,
            'asrModel': common.ASR_MODEL.name, 'diarizationModel': segmentation.name}
