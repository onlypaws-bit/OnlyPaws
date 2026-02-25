async function loadPartial(selector, url) {
  const el = document.querySelector(selector);
  if (!el) {
    console.warn("loadPartial: missing element", selector);
    return;
  }

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);

  el.innerHTML = await res.text();
}

// app layout (logged pages)
async function loadLayout() {
  await loadPartial("#header-placeholder", "components/header.html");
  await loadPartial("#footer-placeholder", "components/footer.html");
}

// marketing layout (index/fans/creators/faq/etc)
async function loadMarketingLayout() {
  await loadPartial("#header-placeholder", "components/header-marketing.html");
  await loadPartial("#footer-placeholder", "components/footer-marketing.html");
}
