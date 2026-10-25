import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Tiny i18n layer.
 *
 * No runtime dependency: a flat key/value dictionary per language plus a context.
 * The choice is persisted in `localStorage` and reflected on `<html lang>` so screen
 * readers, spell checkers and the browser's own UI follow the page language.
 */

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'pc.lang';

const en = {
  // The button names the language you switch TO; the tooltip is written in the
  // current interface language, with the target in brackets.
  'lang.switchTo': 'Switch to Chinese (中文)',
  'lang.label': '中文',

  'brand.tagline': 'one canvas · everyone draws',

  'state.connecting': 'connecting',
  'state.online': 'live',
  'state.offline': 'offline',
  'state.reconnecting': 'reconnecting',
  'state.fatal': 'session expired',

  'header.onlineCount': 'online',
  'header.pixelCount': 'pixels',
  'header.onlineTitle': 'People currently connected',
  'header.pixelsTitle': 'Total accepted pixels',
  'header.latencyTitle': 'Round-trip latency',

  'nav.history': 'History',
  'nav.historyTitle': 'History & snapshots',
  'nav.help': 'Help',
  'nav.helpTitle': 'Rules & help',
  'nav.admin': 'Admin',
  'nav.adminTitle': 'Admin console',
  'nav.xTitle': 'Follow the maker on X (@0xkillcoin)',

  'cooldown.ready': 'Ready',
  'cooldown.placeTitle': 'Place a pixel (or tap the canvas)',
  'cooldown.waitingTitle': 'Waiting for the server',
  'cooldown.offlineHint': 'offline - the server decides when you can paint',
  'cooldown.readyHint': 'pick a colour, tap the canvas',
  'cooldown.waitingHint': 'server-enforced cooldown',

  'palette.title': 'Palette',
  'palette.aria': 'Colour palette',
  'palette.ready': 'ready',
  'palette.cooling': 'cooling',
  'palette.colour': 'Colour {hex}',
  'palette.recentColour': 'Recent colour {hex}',
  'palette.recent': 'Recent',
  'palette.customHead': 'Custom → nearest palette',
  'palette.customAria': 'Custom colour',
  'palette.apply': 'use #{index} · {hex}',
  'palette.footnote':
    'The canvas stores palette indices, so a custom colour snaps to its closest palette entry — that keeps the artwork consistent and the socket payload one byte per pixel.',

  'activity.title': 'Live activity',
  'activity.aria': 'Recent activity',
  'activity.quiet': 'quiet',
  'activity.moves': '{count} moves',
  'activity.empty': 'No pixels yet. Place the very first one - it will be in the history forever.',
  'activity.you': 'you',
  'activity.jumpTitle': 'Centre the canvas here',
  'activity.topPainters': 'Top painters',
  'activity.rankEmpty': 'Rankings appear after the first pixels land.',
  'activity.now': 'now',

  'notice.dismiss': 'Dismiss',

  'conn.sessionLevel': 'session',
  'conn.sessionText': 'Your session expired. Reload the page to get a fresh anonymous identity.',
  'conn.reload': 'reload',
  'conn.offlineLevel': 'offline',
  'conn.retryLevel': 'retrying',
  'conn.offlineText': 'You are offline. Pixels cannot be sent until the connection returns.',
  'conn.retryText': 'Reconnecting to the canvas',
  'conn.retryAttempt': ' (attempt {count})',
  'conn.retryNow': 'retry now',

  'modal.close': 'Close',

  'report.title': 'Report pixel ({x}, {y})',
  'report.intro':
    'Reports go to a moderation queue with the offending coordinate, never to the public timeline. Misuse of the report form is rate limited per session.',
  'report.reason': 'Reason',
  'report.details': 'Details (optional)',
  'report.placeholder': 'What is wrong with this area?',
  'report.cancel': 'cancel',
  'report.submit': 'send report',

  'reason.offensive': 'Offensive content',
  'reason.spam': 'Spam / advertising',
  'reason.copyright': 'Copyright issue',
  'reason.other': 'Something else',

  'history.title': 'History & snapshots',
  'history.download': 'Download',
  'history.exportNote':
    'The export is rendered server-side from the authoritative canvas, so it always matches what everyone else sees.',
  'history.png1x': 'PNG 1× ({size}px)',
  'history.png4x': 'PNG 4×',
  'history.jump': 'Jump to a coordinate',
  'history.centre': 'centre',
  'history.xAria': 'X coordinate',
  'history.yAria': 'Y coordinate',
  'history.timeMachine': 'Time machine',
  'history.snapshotEmpty':
    'A snapshot is taken automatically every 10 minutes of drawing activity. None exist yet — paint something and come back.',
  'history.snapshotMeta': '{pixels} pixels · v{version}',
  'history.view': 'view',

  'help.title': 'How Pixel Commons works',
  'help.rulesHead': 'The rules',
  'help.rule1': 'One shared canvas. Everyone paints the same artwork.',
  'help.rule2a': 'One pixel every',
  'help.rule2b': 'seconds',
  'help.rule2c': ', enforced by the server — refreshing or opening more tabs does not give you extra turns.',
  'help.rule3': 'Pixels are permanent unless an admin resets the canvas.',
  'help.rule4': 'No accounts, no email: you get a signed anonymous session that lasts 30 days.',
  'help.controlsHead': 'Controls',
  'help.desktopLead': 'Desktop:',
  'help.desktopText': 'scroll to zoom, drag to pan, click to place. Hold Shift + click a pixel to report it.',
  'help.phoneLead': 'Phone:',
  'help.phoneText': 'pinch to zoom, drag with one finger to pan, tap to place. Long-press a pixel to report it.',
  'help.shareLead': 'Share links look like',
  'help.shareText': 'and open centred on that pixel.',
  'help.fairHead': 'Fair play',
  'help.fair1': 'The client never decides cooldown, colour validity or coordinates — the Durable Object does.',
  'help.fair2': 'Rate limits apply per connection and per session; automated spam is dropped.',
  'help.fair3': 'Content reports are reviewed by admins; the queue and every admin action are logged.',
  'help.ossHead': 'Open source',
  'help.ossText':
    'Pixel Commons is MIT licensed. Fork it, run your own canvas, or deploy it to your own Cloudflare account — the README walks through the whole thing.',

  'app.openedAt': 'Opened at ({x}, {y})',
  'app.offlinePixel': 'You are offline — the pixel was not sent.',
  'app.cooldownLeft': 'Cooldown: {seconds}s left.',
  'app.tapPixel': 'Tap a pixel on the canvas to place it.',
  'app.shareCopied': 'Share link copied — it opens centred on that pixel.',
  'app.copyPrompt': 'Copy this link:',
  'app.hoverFirst': 'Hover or tap a pixel first.',
  'app.reportSent': 'Report sent to the moderation queue.',
  'app.storageLevel': 'storage',
  'app.storageText':
    'The canvas is running in memory only right now - pixels are visible to everyone but may not survive a restart. History, snapshots and export are paused until storage recovers.',
  'app.loadingCanvas': 'Loading the shared canvas…',
  'app.connectingRoom': 'connecting to the realtime room',
  'app.share': 'share',
  'app.report': 'report',
  'app.tabColours': 'colours',
  'app.tabActivity': 'activity',
  'app.sessionTitle': 'Your session',
  'app.sessionAdmin': 'admin',
  'app.sessionAnon': 'anonymous',
  'app.handle': 'handle',
  'app.pixelsPlaced': 'pixels placed',
  'app.cooldownPerPixel': 'cooldown',
  'app.perPixel': 'per pixel',
  'app.refreshFeed': 'refresh feed',
  'app.footerLicence': 'MIT licensed',
  'app.footerStatic': 'static build on GitHub Pages',
  'app.footerWorker': 'Cloudflare Worker + Durable Object',
  'app.footerBuiltBy': 'built by',
  'app.bootTitle': 'Pixel Commons could not start',
  'app.bootHint1': 'The real-time server lives at',
  'app.bootHint2': 'If you opened a static export, make sure',
  'app.bootHint3': 'points at the deployed Worker.',
  'app.retry': 'retry',
  'app.canvasAria': 'Shared pixel canvas',
  'app.zoomControls': 'Zoom controls',
  'app.zoomIn': 'Zoom in',
  'app.zoomOut': 'Zoom out',
  'app.zoomFit': 'Fit canvas to screen',

  'admin.signInTitle': 'Admin sign-in',
  'admin.signInIntro':
    'Admins can reset the canvas, publish maintenance notices, undo the last pixel and open the reports queue. The token is verified on the server and exchanged for a short-lived signed cookie.',
  'admin.tokenLabel': 'Admin token',
  'admin.checking': 'checking…',
  'admin.signIn': 'sign in',
  'admin.cancel': 'cancel',
  'admin.signedIn': 'Admin signed in.',
  'admin.signInFailed': 'Sign-in failed.',
  'admin.loadFailed': 'Could not load the admin view.',
  'admin.actionFailed': 'Action failed.',
  'admin.title': 'Admin console',
  'admin.broadcast': 'Broadcast notice',
  'admin.level': 'Level',
  'admin.levelInfo': 'info',
  'admin.levelWarn': 'warn',
  'admin.levelMaintenance': 'maintenance (blocks painting)',
  'admin.message': 'Message',
  'admin.messagePlaceholder': 'Theme day: build a tiny garden in the bottom-left quadrant',
  'admin.publish': 'publish',
  'admin.publishDone': 'Notice published.',
  'admin.clear': 'clear',
  'admin.clearDone': 'Notice cleared.',
  'admin.canvas': 'Canvas',
  'admin.undo': 'undo last pixel',
  'admin.undoDone': 'Undone.',
  'admin.exportPng': 'export PNG',
  'admin.resetLabel': 'Type RESET to clear the whole canvas',
  'admin.reset': 'reset canvas',
  'admin.resetDone': 'Canvas reset.',
  'admin.reports': 'Reports',
  'admin.openCount': '({count} open)',
  'admin.loading': 'loading…',
  'admin.noReports': 'No reports yet.',
  'admin.resolve': 'resolve',
  'admin.reject': 'reject',
  'admin.audit': 'Audit trail',
  'admin.noAudit': 'No admin actions recorded yet.',

  'reject.cooldown': 'Cooldown: the server will accept your next pixel in {seconds}s.',
  'reject.out_of_bounds': 'That pixel is outside the canvas.',
  'reject.bad_color': 'That colour is not in the palette.',
  'reject.bad_request': 'The server could not understand that request.',
  'reject.rate_limited': 'Slow down a little - too many actions.',
  'reject.maintenance': 'The canvas is in maintenance mode right now.',
  'reject.forbidden': 'This canvas reached its pixel budget.',
  'reject.unchanged': 'That pixel already has this colour - no cooldown spent.',
  'reject.server_error': 'Something went wrong on the server. Please retry.',
  'reject.storage': 'Your pixel is visible to everyone, but the server could not save it yet (storage limit).',
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  'lang.switchTo': '切换到英文 (English)',
  'lang.label': 'EN',

  'brand.tagline': '一块画布 · 所有人共同作画',

  'state.connecting': '连接中',
  'state.online': '在线',
  'state.offline': '离线',
  'state.reconnecting': '重连中',
  'state.fatal': '会话已过期',

  'header.onlineCount': '在线',
  'header.pixelCount': '像素',
  'header.onlineTitle': '当前在线人数',
  'header.pixelsTitle': '累计有效像素数',
  'header.latencyTitle': '往返延迟',

  'nav.history': '历史',
  'nav.historyTitle': '历史与快照',
  'nav.help': '帮助',
  'nav.helpTitle': '规则与帮助',
  'nav.admin': '管理',
  'nav.adminTitle': '管理后台',
  'nav.xTitle': '在 X 上关注作者（@0xkillcoin）',

  'cooldown.ready': '就绪',
  'cooldown.placeTitle': '放置像素（也可以直接点击画布）',
  'cooldown.waitingTitle': '等待服务器',
  'cooldown.offlineHint': '离线中 —— 何时可以落笔由服务器决定',
  'cooldown.readyHint': '选一个颜色，点击画布',
  'cooldown.waitingHint': '服务器端冷却中',

  'palette.title': '调色板',
  'palette.aria': '调色板',
  'palette.ready': '就绪',
  'palette.cooling': '冷却中',
  'palette.colour': '颜色 {hex}',
  'palette.recentColour': '最近使用颜色 {hex}',
  'palette.recent': '最近使用',
  'palette.customHead': '自定义 → 就近调色板',
  'palette.customAria': '自定义颜色',
  'palette.apply': '使用 #{index} · {hex}',
  'palette.footnote':
    '画布只存储调色板索引，因此自定义颜色会自动吸附到最接近的色板色 —— 这样作品风格统一，每个像素在网络上也只占一个字节。',

  'activity.title': '实时动态',
  'activity.aria': '最近动态',
  'activity.quiet': '安静',
  'activity.moves': '{count} 次操作',
  'activity.empty': '还没有像素。来放下第一个吧 —— 它会永远留在历史里。',
  'activity.you': '你',
  'activity.jumpTitle': '把画布居中到这里',
  'activity.topPainters': '涂格榜',
  'activity.rankEmpty': '有人落笔后这里就会出现排名。',
  'activity.now': '刚刚',

  'notice.dismiss': '关闭',

  'conn.sessionLevel': '会话',
  'conn.sessionText': '会话已过期。刷新页面即可获得新的匿名身份。',
  'conn.reload': '刷新',
  'conn.offlineLevel': '离线',
  'conn.retryLevel': '重连中',
  'conn.offlineText': '你已离线。连接恢复前无法发送像素。',
  'conn.retryText': '正在重新连接画布',
  'conn.retryAttempt': '（第 {count} 次尝试）',
  'conn.retryNow': '立即重试',

  'modal.close': '关闭',

  'report.title': '举报像素 ({x}, {y})',
  'report.intro': '举报会带着坐标进入审核队列，不会出现在公开时间线上。滥用举报表单会被按会话限流。',
  'report.reason': '原因',
  'report.details': '补充说明（可选）',
  'report.placeholder': '这一区域有什么问题？',
  'report.cancel': '取消',
  'report.submit': '提交举报',

  'reason.offensive': '冒犯性内容',
  'reason.spam': '垃圾信息 / 广告',
  'reason.copyright': '版权问题',
  'reason.other': '其他情况',

  'history.title': '历史与快照',
  'history.download': '下载',
  'history.exportNote': '导出的图片由服务器根据权威画布渲染，因此与所有人看到的完全一致。',
  'history.png1x': 'PNG 1×（{size}px）',
  'history.png4x': 'PNG 4×',
  'history.jump': '跳转到坐标',
  'history.centre': '居中',
  'history.xAria': 'X 坐标',
  'history.yAria': 'Y 坐标',
  'history.timeMachine': '时光机',
  'history.snapshotEmpty': '画布每有 10 分钟绘制活动就会自动生成一张快照。目前还没有 —— 先去画点什么再回来看看。',
  'history.snapshotMeta': '{pixels} 像素 · v{version}',
  'history.view': '查看',

  'help.title': 'Pixel Commons 玩法说明',
  'help.rulesHead': '规则',
  'help.rule1': '只有一块画布，所有人都在同一幅作品上作画。',
  'help.rule2a': '每',
  'help.rule2b': '秒可以放置一个像素',
  'help.rule2c': '，由服务器强制执行 —— 刷新页面或多开标签页都不能多画。',
  'help.rule3': '像素会永久保留，除非管理员重置画布。',
  'help.rule4': '无需账号、无需邮箱：你会得到一个有效期为 30 天的签名匿名会话。',
  'help.controlsHead': '操作方式',
  'help.desktopLead': '桌面端：',
  'help.desktopText': '滚轮缩放、拖拽平移、单击放置。按住 Shift 再点击像素可以举报。',
  'help.phoneLead': '手机端：',
  'help.phoneText': '双指缩放、单指拖动平移、轻点放置。长按像素可以举报。',
  'help.shareLead': '分享链接形如',
  'help.shareText': '，打开后会居中定位到该像素。',
  'help.fairHead': '公平性',
  'help.fair1': '冷却时间、颜色合法性与坐标全部由 Durable Object 判定，客户端无权决定。',
  'help.fair2': '按连接和会话双重限流，自动化刷屏会被丢弃。',
  'help.fair3': '内容举报由管理员审核，举报队列与每一次管理操作都有日志。',
  'help.ossHead': '开源',
  'help.ossText':
    'Pixel Commons 使用 MIT 许可证。你可以 fork 后运行自己的画布，或部署到自己的 Cloudflare 账号 —— README 里有完整步骤。',

  'app.openedAt': '已定位到 ({x}, {y})',
  'app.offlinePixel': '你已离线 —— 像素没有发送出去。',
  'app.cooldownLeft': '冷却中：还剩 {seconds} 秒。',
  'app.tapPixel': '请在画布上点选一个像素来放置。',
  'app.shareCopied': '分享链接已复制 —— 打开后会居中定位到该像素。',
  'app.copyPrompt': '复制此链接：',
  'app.hoverFirst': '请先悬停或点选一个像素。',
  'app.reportSent': '举报已提交到审核队列。',
  'app.storageLevel': '存储',
  'app.storageText':
    '画布当前仅运行在内存中 —— 像素对所有人可见，但服务器重启后可能不会保留。历史、快照与导出将在存储恢复后重新可用。',
  'app.loadingCanvas': '正在加载共享画布……',
  'app.connectingRoom': '正在连接实时房间',
  'app.share': '分享',
  'app.report': '举报',
  'app.tabColours': '颜色',
  'app.tabActivity': '动态',
  'app.sessionTitle': '你的会话',
  'app.sessionAdmin': '管理员',
  'app.sessionAnon': '匿名',
  'app.handle': '昵称',
  'app.pixelsPlaced': '已放置像素',
  'app.cooldownPerPixel': '冷却',
  'app.perPixel': '每个像素',
  'app.refreshFeed': '刷新动态',
  'app.footerLicence': 'MIT 许可',
  'app.footerStatic': 'GitHub Pages 静态构建',
  'app.footerWorker': 'Cloudflare Worker + Durable Object',
  'app.footerBuiltBy': '作者',
  'app.bootTitle': 'Pixel Commons 启动失败',
  'app.bootHint1': '实时服务位于',
  'app.bootHint2': '如果你打开的是静态构建，请确认',
  'app.bootHint3': '指向已部署的 Worker。',
  'app.retry': '重试',
  'app.canvasAria': '共享像素画布',
  'app.zoomControls': '缩放控件',
  'app.zoomIn': '放大',
  'app.zoomOut': '缩小',
  'app.zoomFit': '适配屏幕',

  'admin.signInTitle': '管理员登录',
  'admin.signInIntro':
    '管理员可以重置画布、发布维护公告、撤销最近一个像素，并处理举报队列。令牌会在服务端校验，并换取一个短期签名 Cookie。',
  'admin.tokenLabel': '管理员令牌',
  'admin.checking': '校验中……',
  'admin.signIn': '登录',
  'admin.cancel': '取消',
  'admin.signedIn': '管理员已登录。',
  'admin.signInFailed': '登录失败。',
  'admin.loadFailed': '无法加载管理视图。',
  'admin.actionFailed': '操作失败。',
  'admin.title': '管理后台',
  'admin.broadcast': '广播公告',
  'admin.level': '级别',
  'admin.levelInfo': '提示',
  'admin.levelWarn': '警告',
  'admin.levelMaintenance': '维护中（禁止作画）',
  'admin.message': '内容',
  'admin.messagePlaceholder': '主题日：在左下角区域一起画一座小花园',
  'admin.publish': '发布',
  'admin.publishDone': '公告已发布。',
  'admin.clear': '清除',
  'admin.clearDone': '公告已清除。',
  'admin.canvas': '画布',
  'admin.undo': '撤销最后一个像素',
  'admin.undoDone': '已撤销。',
  'admin.exportPng': '导出 PNG',
  'admin.resetLabel': '输入 RESET 以清空整块画布',
  'admin.reset': '重置画布',
  'admin.resetDone': '画布已重置。',
  'admin.reports': '举报',
  'admin.openCount': '（{count} 条待处理）',
  'admin.loading': '加载中……',
  'admin.noReports': '暂无举报。',
  'admin.resolve': '已处理',
  'admin.reject': '驳回',
  'admin.audit': '操作日志',
  'admin.noAudit': '暂无管理操作记录。',

  'reject.cooldown': '冷却中：服务器将在 {seconds} 秒后接受你下一个像素。',
  'reject.out_of_bounds': '这个像素在画布范围之外。',
  'reject.bad_color': '该颜色不在调色板中。',
  'reject.bad_request': '服务器无法理解这次请求。',
  'reject.rate_limited': '请慢一点 —— 操作太频繁了。',
  'reject.maintenance': '画布当前处于维护模式。',
  'reject.forbidden': '画布已达到像素总量上限。',
  'reject.unchanged': '这个像素已经是该颜色了 —— 不会消耗冷却。',
  'reject.server_error': '服务器出错了，请重试。',
  'reject.storage': '你的像素对所有人可见，但服务器暂时无法保存（存储额度限制）。',
};

export const messages: Record<Lang, Record<MessageKey, string>> = { en, zh };

export const locales: Record<Lang, string> = { en: 'en-US', zh: 'zh-CN' };

function readInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* storage may be blocked */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

type Vars = Record<string, string | number>;

export type I18n = {
  lang: Lang;
  locale: string;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  /** Translate a key, interpolating `{name}` placeholders. */
  t: (key: MessageKey, vars?: Vars) => string;
};

const fallback: I18n = {
  lang: 'en',
  locale: locales.en,
  setLang: () => undefined,
  toggle: () => undefined,
  t: (key, vars) => interpolate(en[key] ?? key, vars),
};

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

const I18nContext = createContext<I18n>(fallback);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const toggle = useCallback(() => setLangState((prev) => (prev === 'en' ? 'zh' : 'en')), []);

  const value = useMemo<I18n>(() => {
    const dict = messages[lang];
    return {
      lang,
      locale: locales[lang],
      setLang,
      toggle,
      t: (key, vars) => interpolate(dict[key] ?? en[key] ?? String(key), vars),
    };
  }, [lang, setLang, toggle]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18n {
  return useContext(I18nContext);
}

/** Report reasons live in the shared protocol, so their labels are mapped here. */
export const reasonKeys = {
  offensive: 'reason.offensive',
  spam: 'reason.spam',
  copyright: 'reason.copyright',
  other: 'reason.other',
} as const satisfies Record<string, MessageKey>;
