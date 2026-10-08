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
      },
      en: {
        label: 'pocket',
        close: 'Close',
        opening: 'Opening phone connection…',
        frameTitle: 'Connect Mobile Device',
        openFailed: 'Failed to open the phone connection. Restart DSH and try again.',
        reactUnavailable: 'react unavailable: the client half registers no UI (check dsh.client.inject in package.json)',
        slotsUnavailable: 'slots service unavailable: UI not mounted (check dsh.client.inject in package.json)',
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

    var modal = { open: false, overlay: null, body: null, panel: null, close: null, frame: null, statusKey: 'opening' }

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
    }

    /* 语言切换时将已打开的模态外壳文案重解析（内嵌配对页自带中英，不受影响）。 */
    function refreshModalLocale() {
      if (!modal.open) return
      if (modal.panel) modal.panel.setAttribute('aria-label', t('label'))
      if (modal.close) modal.close.setAttribute('aria-label', t('close'))
      if (modal.frame) modal.frame.setAttribute('title', t('frameTitle'))
      if (modal.body) {
        var shown = modal.body.querySelector('.dsh-pocket-status')
        if (shown) shown.textContent = t(modal.statusKey)
      }
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

      var body = document.createElement('div')
      body.style.cssText = 'flex:1;min-height:0;position:relative;'

      var status = document.createElement('div')
      status.className = 'dsh-pocket-status'
      status.textContent = t('opening')
      body.appendChild(status)

      var frame = document.createElement('iframe')
      frame.setAttribute('title', t('frameTitle'))
      frame.setAttribute('allow', 'clipboard-write')
      frame.addEventListener('load', function () {
        var node = body.querySelector('.dsh-pocket-status')
        if (node && node.parentNode) node.parentNode.removeChild(node)
        frame.style.display = 'block'
      })
      frame.addEventListener('error', function () {
        setStatus('openFailed')
      })
      body.appendChild(frame)

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
