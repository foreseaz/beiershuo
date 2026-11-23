"""Claude calls for the editorial steps. Model and request settings live only here."""

import json
import os

import anthropic


MODEL = os.environ.get("BEIERSHUO_MODEL", "claude-opus-5-5")
# Server-side refusal fallback: a declined request is re-run on Anthropic's
# recommended fallback model inside the same call instead of failing the batch.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client = None


class ModelError(RuntimeError):
    pass


def _get_client():
    global _client
    if _client is None:
        # Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
        _client = anthropic.Anthropic()
    return _client


def structured(system, prompt, schema, *, effort="high", max_tokens=32000):
    """Return (parsed JSON matching `schema`, call metadata).

    The system prompt is cached, so per-episode calls that share the topic
    table only pay for it once every few minutes.
    """
    try:
        with _get_client().beta.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError as error:
        raise ModelError(
            "Claude rejected the credentials. Put ANTHROPIC_API_KEY in .env or run `ant auth login`."
        ) from error
    except anthropic.RateLimitError as error:
        raise ModelError("Claude rate limit reached. Wait a minute and rerun; finished items are kept.") from error
    except anthropic.APIStatusError as error:
        raise ModelError(f"Claude API error {error.status_code}: {error.message}") from error
    except anthropic.APIConnectionError as error:
        raise ModelError(f"Cannot reach the Claude API: {error}") from error
    except TypeError as error:
        # The SDK raises TypeError before sending anything when no credentials resolve.
        if "authentication" not in str(error):
            raise
        raise ModelError("No Claude credentials found. Put ANTHROPIC_API_KEY in .env or run `ant auth login`.") from error

    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        raise ModelError(f"Claude declined this request ({getattr(details, 'category', None) or 'no category'}).")
    if message.stop_reason == "max_tokens":
        raise ModelError("Claude's answer was cut off at max_tokens. Rerun this item with a smaller batch.")
    text = next((block.text for block in message.content if block.type == "text"), None)
    if text is None:
        raise ModelError("Claude returned no JSON answer.")
    usage = message.usage
    meta = {
        "model": message.model,
        "inputTokens": usage.input_tokens,
        "cachedTokens": usage.cache_read_input_tokens or 0,
        "outputTokens": usage.output_tokens,
    }
    return json.loads(text), meta
