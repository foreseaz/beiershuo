// Official platform artwork from Apple Podcasts Identity Guidelines and 小宇宙素材中心。
const APPLE_PODCASTS_ICON = '/brand/apple-podcasts-icon.png'
const XIAOYUZHOU_ICON = '/brand/xiaoyuzhou-icon.png'
export const APPLE_PODCASTS_BADGE = '/brand/apple-podcasts-listen.svg'
export const XIAOYUZHOU_BADGE = '/brand/xiaoyuzhou-listen.png'

export function ApplePodcastsIcon({ size = 16 }: { size?: number }) {
  return <img className="platform-icon" src={APPLE_PODCASTS_ICON} alt="" width={size} height={size} />
}

export function XiaoyuzhouIcon({ size = 16 }: { size?: number }) {
  return <img className="platform-icon" src={XIAOYUZHOU_ICON} alt="" width={size} height={size} />
}
