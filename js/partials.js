async function loadPartial(selector, url) {
  const el = document.querySelector(selector);
  if (!el) return;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}`);

  el.innerHTML = await res.text();
}

// default: app layout
async function loadLayout() {
  await loadPartial("#header-placeholder", "components/header.html");
  await loadPartial("#footer-placeholder", "components/footer.html");
}

// NEW: marketing layout (index/fans/creators/faq/etc)
async function loadMarketingLayout() {
  await loadPartial("#header-placeholder", "components/header-marketing.html");
  await loadPartial("#footer-placeholder", "components/footer-marketing.html");
}