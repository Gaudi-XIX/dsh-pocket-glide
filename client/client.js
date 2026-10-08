/* @defws/dsh-pocket client —— 侧栏常驻「pocket」按钮 + dataelement 原版配对页。
 * 注册纪律：必须用 window.__ModuleLoader__.load({id, factory}) 按【包名】注册，
 * 不能写 ESM export（宿主客户端半区不走 ESM 解析，SyntaxError 会触发安全模式）。
 *
 * 点击按钮 → 应用内模态内嵌 /desktop：该路径由插件 node 半区注册在宿主
 * webServer 上，转发给桥的 dataelement renderDesktopPairingPage（配色/暗色模式/
 * 二维码/WiFi·互联网切换/连接密码全部原样）。iframe 与宿主同源（dsh-app://app），
 * 因此没有跨站 cookie 与 CSRF 问题；本文件不重写任何一行配对 UI。 */
console.log('[dsh-pocket] client fingerprint: app-origin-pairing-iframe-v5')
window.__ModuleLoader__.load({
  id: '@defws/dsh-pocket',
  factory: function (require) {
    var module = { exports: {} }

    /* ---------------- 文案表（i18n，集中一处）----------------
     * 面向用户的串全部落在 I18N：zh / en 两包键集合必须相等（AC-CLI 按
     * Object.keys 对账），新增文案一律两边同批加。
     * 语言判定优先宿主 locale 服务（ctx.locale.getLocale().active，与 dsh-memory-river
     * client 半区同机制），服务缺席时退回 <html lang>；判定式 /^zh/i 与 pages 侧统一，
     * 未知语言一律回落 en。
     * 字面配对齐 lib/pages.js 桌面配对页既有中英：入口名 pocket（手机端页面
     * 指引里指代本按钮的同一称呼），内嵌页标题 Connect Mobile Device（= text.title）。 */
    var I18N = {
      zh: {
        label: 'pocket',
        close: '关闭',
        opening: '正在打开手机连接…',
        frameTitle: '连接移动设备',
        openFailed: '手机连接打开失败，请重启 DSH 后再试。',
        reactUnavailable: 'react 不可用：client 半区不注册 UI（请核对 package.json dsh.client.inject）',
        slotsUnavailable: 'slots 服务不可用：UI 未挂载（请核对 package.json dsh.client.inject）',
        tabConnect: '连接',
        tabDevices: '已配对设备',
        devicesLoading: '正在读取设备列表…',
        devicesEmpty: '还没有已配对的设备。',
        devicesFailed: '设备列表读取失败。',
        retry: '重试',
        deviceOnline: '在线',
        deviceOffline: '离线',
        deviceFingerprint: '指纹',
        firstPaired: '首次配对',
        credExpiry: '凭证到期',
        lastSeen: '最后上线',
        neverSeen: '未记录',
        permLan: '仅本地',
        permLanWan: '本地+公网',
        permBadge: '通道权限：{v}',
        permMakeLan: '切为仅本地',
        permMakeWan: '开启公网',
        extend: '延长30天',
        credExpiredFmt: '{d}（已过期）',
        revoke: '吊销',
        revokeArmed: '确认吊销',
        revokeConfirm: '吊销后该设备需重新配对。确认吊销？',
        extendDone: '已延长 30 天',
        permDone: '权限已更新',
        revokeDone: '已吊销',
        actionFailed: '操作失败',
      },
      en: {
        label: 'pocket',
        close: 'Close',
        opening: 'Opening phone connection…',
        frameTitle: 'Connect Mobile Device',
        openFailed: 'Failed to open the phone connection. Restart DSH and try again.',
        reactUnavailable: 'react unavailable: the client half registers no UI (check dsh.client.inject in package.json)',
        slotsUnavailable: 'slots service unavailable: UI not mounted (check dsh.client.inject in package.json)',
        tabConnect: 'Connect',
        tabDevices: 'Paired devices',
        devicesLoading: 'Loading the device list…',
        devicesEmpty: 'No paired devices yet.',
        devicesFailed: 'Failed to load the device list.',
        retry: 'Retry',
        deviceOnline: 'online',
        deviceOffline: 'offline',
        deviceFingerprint: 'Fingerprint',
        firstPaired: 'First paired',
        credExpiry: 'Credential expires',
        lastSeen: 'Last seen',
        neverSeen: 'never',
        permLan: 'LAN only',
        permLanWan: 'LAN + public',
        permBadge: 'Access: {v}',
        permMakeLan: 'Restrict to LAN',
        permMakeWan: 'Allow public',
        extend: 'Extend 30 days',
        credExpiredFmt: '{d} (expired)',
        revoke: 'Revoke',
        revokeArmed: 'Confirm revoke',
        revokeConfirm: 'This device must pair again after revocation. Revoke?',
        extendDone: 'Extended by 30 days',
        permDone: 'Access updated',
        revokeDone: 'Revoked',
        actionFailed: 'Action failed',
      },
    }
    var ctxRef = null /* apply(ctx) 到达后才有宿主服务；factory 期只能读 <html lang> */
    var locale = resolveLocale()

    function normalizeTag(tag) {
      return /^zh/i.test(String(tag || '')) ? 'zh' : 'en'
    }

    /* 宿主现势语言 → 'zh' | 'en'（未知即 en）。ctxRef 未就位时退回文档 lang 属性。 */
    function resolveLocale() {
      var tag = ''
      try {
        var svc = ctxRef && ctxRef.locale
        if (svc && typeof svc.getLocale === 'function') {
          var got = svc.getLocale()
          if (got && got.active) tag = String(got.active)
        }
      } catch (eLocale) { tag = '' }
      if (!tag) {
        try {
          if (typeof document !== 'undefined' && document.documentElement) tag = String(document.documentElement.lang || '')
        } catch (eLang) { tag = '' }
      }
      return normalizeTag(tag)
    }

    /* locale/change 可能连发；只有真的换了语言才返回 true，避免无谓重注册。 */
    function syncLocale() {
      var next = resolveLocale()
      if (next === locale) return false
      locale = next
      return true
    }

    function t(key) {
      var pack = I18N[locale] || I18N.en
      if (typeof pack[key] === 'string') return pack[key]
      return I18N.en[key] || key
    }

    var React = null
    try { React = require('react') } catch (eReact) { React = null }
    if (!React || typeof React.createElement !== 'function') {
      console.error('[dsh-pocket] ' + t('reactUnavailable'))
      module.exports.inject = []
      module.exports.apply = function () { return function () {} }
      return module.exports
    }
    var h = React.createElement

    var STYLE_ID = 'dsh-pocket-client-css'
    /* 配对页所在路径：由插件 node 半区注册，转发到桥（dataelement 页面）。 */
    var PAIRING_PATH = '/desktop'

    /* 按钮几何孪生宿主设置入口；模态外壳只做遮罩+居中，卡片内部整页由
     * dataelement 页面自己负责。 */
    var CSS = [
      '.dsh-pocket-btn { box-sizing: border-box; width: 100%; height: 42px; min-width: 0;',
      '  margin: 4px 0; padding: 0 10px 0 8px; gap: 8px; flex: none;',
      '  display: inline-flex; align-items: center; justify-content: flex-start;',
      '  font-family: inherit; font-size: 14px; line-height: 22px; white-space: nowrap;',
      '  color: var(--dsw-alias-label-primary); background: transparent; border: none;',
      '  border-radius: var(--dsw-radius-md); cursor: pointer; overflow: hidden; }',
      '.dsh-pocket-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsh-pocket-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid',
      '  var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }',
      '.dsh-pocket-btn .dsh-pocket-label { overflow: hidden; text-overflow: ellipsis; }',
      '.dsh-pocket-btn.dsh-pocket-rail { width: 36px; height: 36px; margin: 8px 0 10px;',
      '  padding: 0; justify-content: center; gap: 0; }',
      '.dsh-pocket-overlay { position: fixed; inset: 0; z-index: 10000;',
      '  background: rgba(0,0,0,.45); display: flex; align-items: center;',
      '  justify-content: center; padding: 24px; }',
      '.dsh-pocket-modal { position: relative; width: 480px; max-width: 100%;',
      '  height: min(740px, 92vh); border-radius: 16px; overflow: hidden;',
      '  box-shadow: 0 12px 48px rgba(0,0,0,.28); background: #fff;',
      '  display: flex; flex-direction: column; }',
      '.dsh-pocket-modal iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }',
      '.dsh-pocket-close { position: absolute; top: 10px; right: 10px; z-index: 2;',
      '  width: 30px; height: 30px; border: 0; border-radius: 50%; cursor: pointer;',
      '  background: rgba(0,0,0,.06); color: #4b4d52; font-size: 15px; line-height: 1;',
      '  display: grid; place-items: center; }',
      '.dsh-pocket-close:hover { background: rgba(0,0,0,.12); }',
      '.dsh-pocket-status { display: grid; place-items: center; height: 100%; padding: 24px;',
      '  text-align: center; color: #81858c; font-size: 13px; }',
      /* —— 已配对设备页签与设备卡（client 半区自绘，桥端只出 JSON）—— */
      '.dsh-pocket-tabs { display: flex; gap: 4px; padding: 10px 12px 0; flex: none; }',
      '.dsh-pocket-tab { appearance: none; border: 1px solid transparent; border-bottom: none;',
      '  background: transparent; color: #6b6f76; font: inherit; font-size: 13px; line-height: 1;',
      '  padding: 8px 14px; border-radius: 9px 9px 0 0; cursor: pointer; }',
      '.dsh-pocket-tab:hover { background: rgba(0,0,0,.05); }',
      '.dsh-pocket-tab[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));',
      '  color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; }',
      '.dsh-pocket-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4e6af2);',
      '  outline-offset: -2px; }',
      '.dsh-pocket-devices { overflow-y: auto; padding: 14px 16px 18px; display: grid;',
      '  gap: 10px; align-content: start; }',
      '.dsh-pocket-devices-note { color: #81858c; font-size: 13px; text-align: center; padding: 24px 0; }',
      '.dsh-pocket-device { border: 1px solid rgba(0,0,0,.08); border-radius: 12px; padding: 10px 12px;',
      '  display: grid; gap: 6px; font-size: 12.5px; color: #3d4148; background: #fff; }',
      '.dsh-pocket-device.is-offline { opacity: .78; }',
      '.dsh-pocket-device-head { display: flex; align-items: center; gap: 8px; min-width: 0; }',
      '.dsh-pocket-device-name { font-weight: 600; font-size: 13.5px; color: #1f2329;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsh-pocket-badge { flex: none; font-size: 11px; line-height: 1; padding: 3px 7px;',
      '  border-radius: 999px; border: 1px solid rgba(0,0,0,.1); color: #6b6f76; }',
      '.dsh-pocket-badge.is-on { color: #0d7a3e; border-color: rgba(13,122,62,.35); background: rgba(13,122,62,.07); }',
      '.dsh-pocket-badge.is-warn { color: #b3261e; border-color: rgba(179,38,30,.35); background: rgba(179,38,30,.06); }',
      '.dsh-pocket-device-meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px;',
      '  color: #6b6f76; }',
      '.dsh-pocket-device-meta dt { margin: 0; }',
      '.dsh-pocket-device-meta dd { margin: 0; color: #3d4148; overflow-wrap: anywhere; }',
      '.dsh-pocket-device-meta dd.is-expired { color: #b3261e; }',
      '.dsh-pocket-device-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }',
      '.dsh-pocket-device-actions button { appearance: none; font: inherit; font-size: 12px; line-height: 1;',
      '  padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #fff;',
      '  color: #3d4148; cursor: pointer; }',
      '.dsh-pocket-device-actions button:hover:not(:disabled) { background: rgba(0,0,0,.05); }',
      '.dsh-pocket-device-actions button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4e6af2);',
      '  outline-offset: -2px; }',
      '.dsh-pocket-device-actions button:disabled { opacity: .55; cursor: default; }',
      '.dsh-pocket-device-actions .is-danger { color: #b3261e; border-color: rgba(179,38,30,.4); }',
      '.dsh-pocket-device-actions .is-danger.armed { background: #b3261e; color: #fff; font-weight: 600; }',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.dataset.plugin = '@defws/dsh-pocket'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* 手机轮廓图标：stroke 线性风格，与宿主 Icon*Outline 同族。 */
    function PhoneIcon(props) {
      return h('svg', {
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.8,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': true,
        focusable: false,
      }, [
        h('rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.5, key: 'r' }),
        h('line', { x1: 10.5, y1: 18.5, x2: 13.5, y2: 18.5, key: 'l' }),
      ])
    }

    /* ---------------- 配对模态（原生 DOM，内部整页来自桥） ---------------- */

    var modal = { open: false, overlay: null, body: null, panel: null, close: null, frame: null, statusKey: 'opening', tab: 'connect', tabs: null, devices: null }

    function onKeydown(event) {
      if (event.key === 'Escape' && modal.open) closeModal()
    }

    function onMessage(event) {
      var data = event && event.data
      if (!data || data.source !== 'dsh-pocket') return
      // 配对页与宿主同源；仍然只认自家来源。
      if (event.origin && event.origin !== window.location.origin) return
      if (data.type === 'done' && modal.open) closeModal()
    }

    function closeModal() {
      modal.open = false
      try {
        document.removeEventListener('keydown', onKeydown)
        window.removeEventListener('message', onMessage)
      } catch (e) {}
      if (modal.overlay && modal.overlay.parentNode) {
        modal.overlay.parentNode.removeChild(modal.overlay)
      }
      modal.overlay = null
      modal.body = null
      modal.panel = null
      modal.close = null
      modal.frame = null
      modal.tabs = null
      modal.devices = null
      modal.tab = 'connect'
    }

    /* ---------------- 已配对设备（client 半区管理页，桥端 /desktop/devices 出数据） ---------------- */

    function localeTag() {
      return locale === 'zh' ? 'zh-CN' : 'en-US'
    }

    /* 时间戳 → 本地短格式；0/缺值返回占位。 */
    function formatTime(ts) {
      if (typeof ts !== 'number' || ts <= 0) return t('neverSeen')
      try {
        return new Date(ts).toLocaleString(localeTag(), {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        })
      } catch (eTime) {
        return String(ts)
      }
    }

    function el(tag, className, textContent) {
      var node = document.createElement(tag)
      if (className) node.className = className
      if (textContent !== undefined) node.textContent = textContent
      return node
    }

    function deviceActionNote(card, key) {
      var note = card.querySelector('.dsh-pocket-action-note')
      if (!note) {
        note = el('div', 'dsh-pocket-action-note')
        note.style.cssText = 'font-size:12px;color:#0d7a3e;'
        card.appendChild(note)
      }
      note.textContent = t(key)
    }

    async function postDeviceAction(path, payload, card, doneKey) {
      try {
        var res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(String(res.status))
        if (card) deviceActionNote(card, doneKey)
        await refreshDevices()
      } catch (eAction) {
        if (card) deviceActionNote(card, 'actionFailed')
      }
    }

    function metaRow(dl, termKey, value, isExpired) {
      dl.appendChild(el('dt', null, t(termKey)))
      var dd = el('dd', isExpired ? 'is-expired' : null, value)
      dl.appendChild(dd)
      return dd
    }

    function formatWith(key, value) {
      return t(key).replace('{v}', value).replace('{d}', value)
    }

    function deviceCard(device) {
      var card = el('div', 'dsh-pocket-device' + (device.online ? '' : ' is-offline'))
      card.dataset.deviceId = String(device.id || '')

      var head = el('div', 'dsh-pocket-device-head')
      head.appendChild(el('span', 'dsh-pocket-device-name', String(device.label || 'Phone')))
      var badge = el('span', 'dsh-pocket-badge' + (device.online ? ' is-on' : ''), t(device.online ? 'deviceOnline' : 'deviceOffline'))
      head.appendChild(badge)
      card.appendChild(head)

      var dl = el('dl', 'dsh-pocket-device-meta')
      metaRow(dl, 'deviceFingerprint', String(device.fingerprint || device.id || ''))
      metaRow(dl, 'firstPaired', formatTime(device.firstPairedAt))
      var expired = typeof device.expiresAt === 'number' && device.expiresAt <= Date.now()
      metaRow(dl, 'credExpiry', expired ? formatWith('credExpiredFmt', formatTime(device.expiresAt)) : formatTime(device.expiresAt), expired)
      metaRow(dl, 'lastSeen', formatTime(device.lastSeenAt))
      card.appendChild(dl)

      var actions = el('div', 'dsh-pocket-device-actions')
      /* 权限切换：按钮文案=点下去会变成的状态（现态在 meta 区已示）。 */
      var isWan = device.permission === 'lan+wan'
      var permBtn = el('button', null, t(isWan ? 'permMakeLan' : 'permMakeWan'))
      permBtn.type = 'button'
      var permBadge = el('span', 'dsh-pocket-badge' + (isWan ? ' is-on' : ' is-warn'), formatWith('permBadge', t(isWan ? 'permLanWan' : 'permLan')))
      permBadge.style.marginRight = 'auto'
      permBadge.style.alignSelf = 'center'
      actions.appendChild(permBadge)
      permBtn.addEventListener('click', function () {
        permBtn.disabled = true
        postDeviceAction('/desktop/device/permission', {
          deviceId: device.id,
          permission: isWan ? 'lan' : 'lan+wan',
        }, card, 'permDone')
      })
      actions.appendChild(permBtn)

      var extendBtn = el('button', null, t('extend'))
      extendBtn.type = 'button'
      extendBtn.addEventListener('click', function () {
        extendBtn.disabled = true
        postDeviceAction('/desktop/device/extend', { deviceId: device.id }, card, 'extendDone')
      })
      actions.appendChild(extendBtn)

      var revokeBtn = el('button', 'is-danger', t('revoke'))
      revokeBtn.type = 'button'
      revokeBtn.title = t('revokeConfirm')
      var revokeTimer = null
      var disarmRevoke = function () {
        if (revokeTimer !== null) { clearTimeout(revokeTimer); revokeTimer = null }
        revokeBtn.classList.remove('armed')
        revokeBtn.dataset.armed = ''
        revokeBtn.textContent = t('revoke')
        revokeBtn.title = t('revokeConfirm')
      }
      revokeBtn.addEventListener('click', function () {
        if (revokeBtn.dataset.armed !== '1') {
          revokeBtn.dataset.armed = '1'
          revokeBtn.classList.add('armed')
          revokeBtn.textContent = t('revokeArmed')
          if (revokeTimer !== null) clearTimeout(revokeTimer)
          revokeTimer = setTimeout(disarmRevoke, 3000)
          return
        }
        if (revokeTimer !== null) { clearTimeout(revokeTimer); revokeTimer = null }
        revokeBtn.disabled = true
        postDeviceAction('/desktop/revoke', { deviceId: device.id }, card, 'revokeDone')
      })
      actions.appendChild(revokeBtn)
      card.appendChild(actions)
      return card
    }

    async function refreshDevices() {
      if (!modal.devices || !modal.open) return
      var host = modal.devices.querySelector('.dsh-pocket-device-list')
      if (!host) return
      try {
        var res = await fetch('/desktop/devices', { headers: { 'content-type': 'application/json' } })
        if (!res.ok) throw new Error(String(res.status))
        var body = await res.json()
        if (!modal.devices || !modal.open) return
        host.textContent = ''
        var list = Array.isArray(body && body.devices) ? body.devices : []
        if (!list.length) {
          host.appendChild(el('div', 'dsh-pocket-devices-note', t('devicesEmpty')))
          return
        }
        for (var i = 0; i < list.length; i++) host.appendChild(deviceCard(list[i]))
      } catch (eLoad) {
        if (!modal.devices || !modal.open) return
        host.textContent = ''
        var note = el('div', 'dsh-pocket-devices-note', t('devicesFailed'))
        var retry = el('button', null, t('retry'))
        retry.type = 'button'
        retry.addEventListener('click', function () { refreshDevices() })
        note.appendChild(document.createElement('br'))
        note.appendChild(retry)
        host.appendChild(note)
      }
    }

    function switchTab(tab) {
      modal.tab = tab
      if (modal.tabs) {
        var buttons = modal.tabs.querySelectorAll('.dsh-pocket-tab')
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].setAttribute('aria-selected', buttons[i].dataset.tab === tab ? 'true' : 'false')
        }
      }
      if (modal.frame) modal.frame.style.display = tab === 'connect' ? 'block' : 'none'
      if (modal.devices) modal.devices.style.display = tab === 'devices' ? 'grid' : 'none'
      if (tab === 'devices') refreshDevices()
    }

    /* 语言切换时将已打开的模态外壳文案重解析（内嵌配对页自带中英，不受影响）。 */
    function refreshModalLocale() {
      if (!modal.open) return
      if (modal.panel) modal.panel.setAttribute('aria-label', t('label'))
      if (modal.close) modal.close.setAttribute('aria-label', t('close'))
      if (modal.tabs) {
        var buttons = modal.tabs.querySelectorAll('.dsh-pocket-tab')
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].textContent = t(buttons[i].dataset.tab === 'devices' ? 'tabDevices' : 'tabConnect')
        }
      }
      if (modal.frame) modal.frame.setAttribute('title', t('frameTitle'))
      if (modal.body) {
        var shown = modal.body.querySelector('.dsh-pocket-status')
        if (shown) shown.textContent = t(modal.statusKey)
      }
      /* 设备页签开着：整列表重拉，卡片文案跟语言走。 */
      if (modal.tab === 'devices') refreshDevices()
    }

    /* 状态文案走键，语言切换后可重解析。 */
    function setStatus(key) {
      if (!modal.body) return
      modal.statusKey = key
      var frame = modal.body.querySelector('iframe')
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame)
      var node = modal.body.querySelector('.dsh-pocket-status')
      if (!node) {
        node = document.createElement('div')
        node.className = 'dsh-pocket-status'
        modal.body.appendChild(node)
      }
      node.textContent = t(key)
    }

    function openModal() {
      if (modal.open) return
      ensureStyle()
      modal.open = true
      modal.statusKey = 'opening'
      modal.tab = 'connect'

      var overlay = document.createElement('div')
      overlay.className = 'dsh-pocket-overlay'

      var panel = document.createElement('div')
      panel.className = 'dsh-pocket-modal'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', t('label'))

      var close = document.createElement('button')
      close.type = 'button'
      close.className = 'dsh-pocket-close'
      close.setAttribute('aria-label', t('close'))
      close.textContent = '✕'
      close.addEventListener('click', closeModal)

      /* 页签：连接（桥端配对页 iframe）/ 已配对设备（本文件自绘管理页）。 */
      var tabs = document.createElement('div')
      tabs.className = 'dsh-pocket-tabs'
      tabs.setAttribute('role', 'tablist')
      var tabConnect = el('button', 'dsh-pocket-tab', t('tabConnect'))
      tabConnect.type = 'button'
      tabConnect.dataset.tab = 'connect'
      tabConnect.setAttribute('role', 'tab')
      tabConnect.setAttribute('aria-selected', 'true')
      var tabDevices = el('button', 'dsh-pocket-tab', t('tabDevices'))
      tabDevices.type = 'button'
      tabDevices.dataset.tab = 'devices'
      tabDevices.setAttribute('role', 'tab')
      tabDevices.setAttribute('aria-selected', 'false')
      tabConnect.addEventListener('click', function () { switchTab('connect') })
      tabDevices.addEventListener('click', function () { switchTab('devices') })
      tabs.appendChild(tabConnect)
      tabs.appendChild(tabDevices)

      var body = document.createElement('div')
      body.style.cssText = 'flex:1;min-height:0;position:relative;'

      var status = document.createElement('div')
      status.className = 'dsh-pocket-status'
      status.textContent = t('opening')
      body.appendChild(status)

      var frame = document.createElement('iframe')
      frame.setAttribute('title', t('frameTitle'))
      frame.setAttribute('allow', 'clipboard-write')
      frame.style.display = 'none'
      frame.addEventListener('load', function () {
        var node = body.querySelector('.dsh-pocket-status')
        if (node && node.parentNode) node.parentNode.removeChild(node)
        // Only the connect tab owns the frame: a user who switched to the
        // device list while the pairing page loaded must not have it painted
        // back over their screen.
        if (modal.tab === 'connect') frame.style.display = 'block'
      })
      frame.addEventListener('error', function () {
        setStatus('openFailed')
      })
      body.appendChild(frame)

      /* 已配对设备页签的本体：数据由桥端 /desktop/devices 出，操作走既有
       * /desktop/revoke 与新的 extend/permission 端点（宿主 webServer 前缀
       * 代理 /desktop*，应用源内同源可达，桌面 cookie 由代理注入）。 */
      var devices = el('div', 'dsh-pocket-devices')
      devices.style.display = 'none'
      var deviceList = el('div', 'dsh-pocket-device-list')
      deviceList.appendChild(el('div', 'dsh-pocket-devices-note', t('devicesLoading')))
      devices.appendChild(deviceList)
      body.appendChild(devices)

      panel.appendChild(tabs)
      panel.appendChild(body)
      panel.appendChild(close)
      overlay.appendChild(panel)
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) closeModal()
      })

      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKeydown)
      window.addEventListener('message', onMessage)

      modal.overlay = overlay
      modal.body = body
      modal.panel = panel
      modal.close = close
      modal.frame = frame
      modal.tabs = tabs
      modal.devices = devices
      frame.src = PAIRING_PATH
    }

    function PocketButton(props) {
      var wide = !!props.wide
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-pocket-btn' + (wide ? '' : ' dsh-pocket-rail'),
          'aria-label': t('label'),
          title: wide ? undefined : t('label'),
          onClick: openModal,
        },
        h(PhoneIcon, { size: wide ? 16 : 18 }),
        wide ? h('span', { className: 'dsh-pocket-label' }, t('label')) : null
      )
    }

    function applyPocket(ctx) {
      ctxRef = ctx
      syncLocale()
      var slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function') {
        console.warn('[dsh-pocket] ' + t('slotsUnavailable'))
        return function () {}
      }
      ensureStyle()
      /* 侧栏注册的 label 在 render 期解析，宿主换语言时重注册一次即可拿到新文案
       * （与 dsh-memory-river client 半区 refreshSurfaces 同法）。 */
      var disposer = null
      function registerSurface() {
        disposer = slots.inject('sidebar.footer.action', function () {
          return slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-pocket-connect',
            order: 0,
          }, function (slotProps) {
            return h(PocketButton, { wide: slotProps ? slotProps.wide : false })
          })
        })
      }
      function refreshSurface() {
        try { if (disposer) disposer() } catch (eR) {}
        disposer = null
        registerSurface()
      }
      registerSurface()
      var unwatch = null
      try {
        if (typeof ctx.on === 'function') {
          unwatch = ctx.on('locale/change', function () {
            if (!syncLocale()) return
            refreshSurface()
            refreshModalLocale()
          })
        }
      } catch (eWatch) { unwatch = null }
      console.log('[dsh-pocket] client ready: sidebar.footer.action "' + t('label') + '" -> ' + PAIRING_PATH)
      return function () {
        try { if (typeof unwatch === 'function') unwatch() } catch (e3) {}
        try { if (disposer) disposer() } catch (e) {}
        try { closeModal() } catch (e2) {}
        ctxRef = null
      }
    }

    module.exports.inject = ['slots']
    module.exports.apply = applyPocket
    return module.exports
  },
})
