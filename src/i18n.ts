/**
 * Landing-page translations: English (the DOM default), 中文, ไทย.
 *
 * English lives in index.html itself rather than in this dictionary, so a visitor with no
 * JavaScript — or one who arrives before this module loads — still reads a complete page in the
 * default language. Switching to another language replaces text; switching back restores the
 * snapshot taken at load, so English never has to be re-typed in two places and cannot drift.
 *
 * Two attributes, deliberately distinct:
 *   data-i18n       replaces textContent — safe for plain strings
 *   data-i18n-html  replaces innerHTML   — for the few nodes carrying <code>/<strong>/<br>
 * A single attribute doing both would mean every string is treated as markup, which turns a
 * translator's stray `<` into a broken page.
 */
export type Lang = 'en' | 'zh' | 'th'

const STORAGE_KEY = 'cometens.lang'

export const DICT: Record<Exclude<Lang, 'en'>, Record<string, string>> = {
  zh: {
    'hero.h1': '给社区成员一个属于他们自己的名字',
    'hero.lead':
      '社区拥有一个 <code>.eth</code> 域名,成员加入时获得它下面的一个子域名。' +
      '成员可以自己改记录、可以转让,不需要经过谁 —— ' +
      '<strong>但合约 owner 仍保留覆写与收回的能力</strong>,下面第 3 步说清楚。',
    'hero.cta1': '查一个名字',
    'hero.cta2': '怎么用起来',
    'badge.testnet': '当前仅测试网',
    'how.title': '它是怎么运作的',
    'how.sub': '三步,没有别的。',
    'how.s1':
      '社区拥有一级域名,比如 <code>community.eth</code>。' +
      '<div class="muted">这是社区在 ENS 上正常持有的名字,不需要交给任何人。</div>',
    'how.s2':
      '成员加入时被授予一个子域名,比如 <code>alice.community.eth</code>。' +
      '<div class="muted">由上游系统自动授予,或由管理员在控制台手动发放。成员不需要注册账号、不需要登录。</div>',
    'how.s3':
      '这个名字全网可解析,而且<strong>归成员自己所有</strong>。' +
      '<div class="muted">它是一枚 ERC-721,成员可以自己改记录、可以转让,不需要经过任何人。<br>' +
      '<strong>但要说准:</strong>合约的 owner 在技术上仍能覆写记录、收回这枚 NFT。' +
      '自部署时 owner 是社区自己;托管时是运营方。' +
      '「名字完全属于成员、谁也拿不走」这句话,<strong>在当前架构下不成立</strong>。</div>',
    'modes.title': '两种用法',
    'modes.self.title': '自己部署',
    'modes.self.sub': '你掌握所有钥匙,不需要信任任何人。',
    'modes.self.body':
      '拿这个仓库跑一套,合约 owner 是你的地址。发放、改记录、解析全在你手里。代价是这些钥匙要你自己保管。',
    'modes.self.badge': 'Apache-2.0 开源',
    'modes.host.title': '交给运营方代跑',
    'modes.host.sub': '域名所有权仍是你的,解析去向随时可收回。',
    'modes.host.body':
      '只需在 ENS 上做一次 <code>setResolver</code>。但要清楚:' +
      '<strong>已发出的子域,运营方在技术上仍能覆写和收回</strong> —— ' +
      '这是那套架构的必然结果,不是可以承诺掉的东西。',
    'modes.host.link': '先读清楚你交出了什么 →',
    'entry.title': '入口',
    'entry.lookup': '查询域名',
    'entry.lookup.sub': '输入名字看归属与解析状态。免登录,不连钱包。',
    'entry.admin': '管理控制台',
    'entry.admin.sub': '运营者手动授予子域、管理 registrar 授权、查改记录。',
    'entry.api': 'API 文档',
    'entry.api.sub': '上游系统在用户加入时自动为他申领子域名。',
    'entry.box': '.box 管理',
    'entry.box.sub': '现有 ENS-tool 的 .box 流程(等待官方接口开放)。',
    footer:
      '当前部署仅覆盖测试网(OP Sepolia / Ethereum Sepolia)。主网尚未上线。<br>' +
      'Apache-2.0 · <a href="https://github.com/MushroomDAO/CometENS">源码</a>',
  },
  th: {
    'hero.h1': 'มอบชื่อที่เป็นของสมาชิกชุมชนอย่างแท้จริง',
    'hero.lead':
      'ชุมชนเป็นเจ้าของชื่อ <code>.eth</code> หนึ่งชื่อ และสมาชิกแต่ละคนจะได้รับชื่อย่อยภายใต้ชื่อนั้น ' +
      'สมาชิกแก้ไขระเบียนของตนเองและโอนชื่อได้โดยไม่ต้องผ่านใคร — ' +
      '<strong>แต่เจ้าของสัญญายังคงมีสิทธิ์เขียนทับและเรียกคืนได้</strong> ดังที่อธิบายในขั้นตอนที่ 3',
    'hero.cta1': 'ค้นหาชื่อ',
    'hero.cta2': 'วิธีใช้งาน',
    'badge.testnet': 'เทสต์เน็ตเท่านั้น',
    'how.title': 'ทำงานอย่างไร',
    'how.sub': 'สามขั้นตอน ไม่มีอย่างอื่น',
    'how.s1':
      'ชุมชนเป็นเจ้าของชื่อระดับแรก เช่น <code>community.eth</code>' +
      '<div class="muted">เป็นชื่อ ENS ปกติที่ชุมชนถือเอง ไม่ต้องมอบให้ใคร</div>',
    'how.s2':
      'สมาชิกจะได้รับชื่อย่อยเมื่อเข้าร่วม เช่น <code>alice.community.eth</code>' +
      '<div class="muted">มอบให้อัตโนมัติโดยระบบต้นทาง หรือผู้ดูแลออกให้ด้วยตนเอง สมาชิกไม่ต้องสมัครและไม่ต้องเข้าสู่ระบบ</div>',
    'how.s3':
      'ชื่อนี้แปลงค่าได้ทั่วเครือข่าย และ<strong>เป็นของสมาชิกเอง</strong>' +
      '<div class="muted">มันคือ ERC-721 สมาชิกแก้ไขระเบียนและโอนได้เองโดยไม่ต้องขอใคร<br>' +
      '<strong>ต้องพูดให้ตรง:</strong> เจ้าของสัญญายังสามารถเขียนทับระเบียนและเรียกคืน NFT นี้ได้ ' +
      'หากติดตั้งเอง เจ้าของคือชุมชน หากให้ผู้ให้บริการดูแล เจ้าของคือผู้ให้บริการ ' +
      'คำกล่าวที่ว่า “ชื่อเป็นของสมาชิกทั้งหมด ไม่มีใครเอาไปได้” <strong>ไม่เป็นจริงในสถาปัตยกรรมนี้</strong></div>',
    'modes.title': 'สองรูปแบบการใช้งาน',
    'modes.self.title': 'ติดตั้งเอง',
    'modes.self.sub': 'คุณถือกุญแจทั้งหมด ไม่ต้องเชื่อใจใคร',
    'modes.self.body':
      'รันโปรเจกต์นี้เอง แล้วเจ้าของสัญญาคือที่อยู่ของคุณ การออกชื่อ แก้ไขระเบียน และการแปลงค่าอยู่ในมือคุณทั้งหมด ' +
      'สิ่งที่ต้องแลกคือคุณต้องเก็บรักษากุญแจเหล่านั้นเอง',
    'modes.self.badge': 'โอเพนซอร์ส Apache-2.0',
    'modes.host.title': 'ให้ผู้ให้บริการดูแล',
    'modes.host.sub': 'ความเป็นเจ้าของยังเป็นของคุณ และเพิกถอนการแปลงค่าได้ทุกเมื่อ',
    'modes.host.body':
      'ทำ <code>setResolver</code> บน ENS เพียงครั้งเดียว แต่ต้องเข้าใจให้ชัด: ' +
      '<strong>สำหรับชื่อที่ออกไปแล้ว ผู้ให้บริการยังเขียนทับและเรียกคืนได้</strong> — ' +
      'นี่เป็นผลที่ตามมาจากสถาปัตยกรรม ไม่ใช่สิ่งที่ใครสัญญาให้หายไปได้',
    'modes.host.link': 'อ่านให้ชัดก่อนว่าคุณกำลังมอบอะไร →',
    'entry.title': 'ทางเข้า',
    'entry.lookup': 'ค้นหาชื่อ',
    'entry.lookup.sub': 'พิมพ์ชื่อเพื่อดูว่าใครเป็นเจ้าของและแปลงค่าไปที่ใด ไม่ต้องเข้าสู่ระบบ ไม่ต้องเชื่อมกระเป๋า',
    'entry.admin': 'คอนโซลผู้ดูแล',
    'entry.admin.sub': 'ออกชื่อย่อยด้วยตนเอง จัดการสิทธิ์ registrar อ่านและแก้ไขระเบียน',
    'entry.api': 'เอกสาร API',
    'entry.api.sub': 'สำหรับระบบต้นทางที่ขอชื่อย่อยให้ผู้ใช้เมื่อเข้าร่วม',
    'entry.box': 'จัดการ .box',
    'entry.box.sub': 'ขั้นตอน .box ของ ENS-tool ที่มีอยู่ (รอเปิดอินเทอร์เฟซอย่างเป็นทางการ)',
    footer:
      'การติดตั้งนี้ครอบคลุมเฉพาะเทสต์เน็ต (OP Sepolia / Ethereum Sepolia) ยังไม่เปิดใช้งานเมนเน็ต<br>' +
      'Apache-2.0 · <a href="https://github.com/MushroomDAO/CometENS">ซอร์สโค้ด</a>',
  },
}

/** The English text as authored in index.html, captured before anything is replaced. */
export function snapshotEnglish(root: ParentNode = document): Map<Element, string> {
  const snap = new Map<Element, string>()
  for (const el of root.querySelectorAll('[data-i18n], [data-i18n-html]')) {
    snap.set(el, el.hasAttribute('data-i18n-html') ? el.innerHTML : (el.textContent ?? ''))
  }
  return snap
}

export function applyLang(lang: Lang, snapshot: Map<Element, string>, root: ParentNode = document): void {
  const dict = lang === 'en' ? null : DICT[lang]
  for (const el of root.querySelectorAll('[data-i18n], [data-i18n-html]')) {
    const isHtml = el.hasAttribute('data-i18n-html')
    const key = (isHtml ? el.getAttribute('data-i18n-html') : el.getAttribute('data-i18n')) ?? ''
    // Falling back to the English snapshot — never to the key — so a missing translation shows
    // real text rather than `how.s2`.
    const text = dict?.[key] ?? snapshot.get(el) ?? ''
    if (isHtml) el.innerHTML = text
    else el.textContent = text
  }
  document.documentElement.lang = lang === 'zh' ? 'zh' : lang === 'th' ? 'th' : 'en'
  for (const b of document.querySelectorAll<HTMLElement>('.lang button')) {
    b.setAttribute('aria-current', String(b.dataset.lang === lang))
  }
}

export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'en' || v === 'zh' || v === 'th' ? v : null
  } catch {
    return null // private windows and blocked storage must not break the page
  }
}

function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore — the switcher still works for this visit */
  }
}

if (typeof document !== 'undefined' && document.querySelector('.lang')) {
  const snapshot = snapshotEnglish()
  const initial = readStoredLang() ?? 'en'
  if (initial !== 'en') applyLang(initial, snapshot)
  else applyLang('en', snapshot)
  for (const b of document.querySelectorAll<HTMLElement>('.lang button')) {
    b.addEventListener('click', () => {
      const lang = b.dataset.lang as Lang
      applyLang(lang, snapshot)
      storeLang(lang)
    })
  }
}
