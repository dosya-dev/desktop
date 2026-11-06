/**
 * Every visible word the player and its report popover write themselves.
 *
 * Additive: a host that passes no `labels` gets exactly the English below.
 * A host that does (the web app, in the chosen language) passes the strings
 * it wants changed; anything it leaves out stays English. The player reads
 * the labels when it mounts.
 */

/** The report popover's words (and the report validation messages). */
export interface ReportLabels {
  /** Heading of the reason list and of the error step. */
  report: string;
  back: string;
  sending: string;
  somethingWentWrong: string;
  reportedThanks: string;
  reportedFollowUp: string;
  formalNotice: string;
  playbackTitle: string;
  playbackSub: string;
  playbackHeading: string;
  playbackNote: string;
  copyrightTitle: string;
  copyrightSub: string;
  copyrightHeading: string;
  copyrightSend: string;
  abuseTitle: string;
  abuseSub: string;
  abuseHeading: string;
  abuseNote: string;
  send: string;
  yourEmail: string;
  sourceUrl: string;
  ownerAttestation: string;
  /** "At 1:23" */
  atTime(time: string): string;
  noDecodeError: string;
  /** "Decode error 3" */
  decodeError(code: number): string;
  /** The user agent label: "Chrome on macOS". */
  browser: string;
  browserOnOs(browser: string, os: string): string;
  detailsTooLong(max: number): string;
  validEmailRequired: string;
  confirmRightsOwner: string;
}

export interface VideoPlayerLabels {
  play: string;
  pause: string;
  skipBack: string;
  skipForward: string;
  loadingVideo: string;
  bufferingFirstFrames: string;
  cantPlayHere: string;
  couldntLoad: string;
  download: string;
  reportAProblem: string;
  /** The aria-label of a comment marker on the seek bar. */
  comment(excerpt: string): string;
  /** The control-bar flag's text. */
  report: string;
  keyboardShortcuts: string;
  close: string;
  shortcutPlayPause: string;
  shortcutSeek5: string;
  shortcutSeek10: string;
  shortcutVolume: string;
  shortcutMute: string;
  shortcutFullscreen: string;
  shortcutPip: string;
  shortcutJump: string;
  shortcutShow: string;
  /** Key caps. */
  keySpace: string;
  keyDoubleClick: string;
  keyEsc: string;
  doubleClickNote: string;
  /** Video.js's own control text, handed over through its language dictionary. */
  progressBar: string;
  currentTime: string;
  duration: string;
  remainingTime: string;
  playbackRate: string;
  pictureInPicture: string;
  exitFullscreen: string;
  reportPopover: ReportLabels;
}

export const DEFAULT_REPORT_LABELS: ReportLabels = {
  report: 'Report',
  back: 'Back',
  sending: 'Sending…',
  somethingWentWrong: 'Something went wrong. Please try again.',
  reportedThanks: 'Reported. Thanks.',
  reportedFollowUp: "We'll look at it and reply if you left an email.",
  formalNotice: 'File a formal notice',
  playbackTitle: "Video won't play",
  playbackSub: "We'll get your browser details automatically",
  playbackHeading: "Video won't play",
  playbackNote: 'What happens? (optional)',
  copyrightTitle: 'Copyright (DMCA)',
  copyrightSub: 'You own this or represent the owner',
  copyrightHeading: 'Copyright claim',
  copyrightSend: 'Send copyright report',
  abuseTitle: 'Harmful or illegal content',
  abuseSub: 'Removed fast if confirmed',
  abuseHeading: 'Harmful content',
  abuseNote: 'What is it? (optional)',
  send: 'Send report',
  yourEmail: 'Your email, so we can reply',
  sourceUrl: 'Link to the original work (optional)',
  ownerAttestation: "I own this work or I'm authorized to act for the owner.",
  atTime: (time) => `At ${time}`,
  noDecodeError: 'No decode error',
  decodeError: (code) => `Decode error ${code}`,
  browser: 'Browser',
  browserOnOs: (browser, os) => `${browser} on ${os}`,
  detailsTooLong: (max) => `Details must be ${max} characters or fewer`,
  validEmailRequired: 'Valid email is required',
  confirmRightsOwner: 'You must confirm you are the rights owner or their agent',
};

export const DEFAULT_LABELS: VideoPlayerLabels = {
  play: 'Play',
  pause: 'Pause',
  skipBack: '−10s',
  skipForward: '+10s',
  loadingVideo: 'Loading video',
  bufferingFirstFrames: 'Buffering first frames',
  cantPlayHere: "Can't play this video here",
  couldntLoad: "Couldn't load this video",
  download: 'Download',
  reportAProblem: 'Report a problem',
  comment: (excerpt) => `Comment: ${excerpt}`,
  report: 'Report',
  keyboardShortcuts: 'Keyboard shortcuts',
  close: 'Close',
  shortcutPlayPause: 'Play or pause',
  shortcutSeek5: 'Back or forward 5 seconds',
  shortcutSeek10: 'Back or forward 10 seconds',
  shortcutVolume: 'Volume up or down',
  shortcutMute: 'Mute',
  shortcutFullscreen: 'Fullscreen',
  shortcutPip: 'Picture in picture',
  shortcutJump: 'Jump to 0% to 90%',
  shortcutShow: 'Show these shortcuts',
  keySpace: 'Space',
  keyDoubleClick: 'Double-click',
  keyEsc: 'Esc',
  doubleClickNote: '(left or right half)',
  progressBar: 'Progress Bar',
  currentTime: 'Current Time',
  duration: 'Duration',
  remainingTime: 'Remaining Time',
  playbackRate: 'Playback Rate',
  pictureInPicture: 'Picture-in-Picture',
  exitFullscreen: 'Exit Fullscreen',
  reportPopover: DEFAULT_REPORT_LABELS,
};

/** What a host passes: any subset, the report popover's labels likewise. */
export type PartialVideoPlayerLabels = Partial<Omit<VideoPlayerLabels, 'reportPopover'>> & {
  reportPopover?: Partial<ReportLabels>;
};

export function resolveReportLabels(partial?: Partial<ReportLabels>): ReportLabels {
  return partial ? { ...DEFAULT_REPORT_LABELS, ...partial } : DEFAULT_REPORT_LABELS;
}

export function resolveLabels(partial?: PartialVideoPlayerLabels): VideoPlayerLabels {
  if (!partial) return DEFAULT_LABELS;
  const { reportPopover, ...rest } = partial;
  return { ...DEFAULT_LABELS, ...rest, reportPopover: resolveReportLabels(reportPopover) };
}
