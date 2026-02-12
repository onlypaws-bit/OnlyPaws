// post-card.js
// Un solo file per UI + binding LIKE per qualunque pagina che renderizza post.
// Dipendenze (global):
// - window.onlypawsClient (supabase client)
// - window.onlypawsLikes (helpers RPC)  [vedi supabase.likes.js]

(() => {
  const FEATURE_LIKES = true;

  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtMoney(cents, currency = "eur") {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "";
    const value = n / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(currency).toUpperCase(),
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${String(currency).toUpperCase()}`;
    }
  }

  function isVideoMedia(media_type, media_url) {
    const mt = String(media_type || "").toLowerCase();
    if (mt.startsWith("video")) return true;
    const url = String(media_url || "").toLowerCase();
    return url.endsWith(".mp4") || url.endsWith(".webm") || url.endsWith(".mov") || url.endsWith(".m4v");
  }

  function mediaHtml(post, locked) {
    const url = post?.media_url;
    if (!url) return "";
    const isVideo = isVideoMedia(post.media_type, url);

    const mediaEl = isVideo
      ? `<video ${locked ? "" : "controls"} playsinline preload="metadata" src="${esc(url)}"></video>`
      : `<img src="${esc(url)}" alt="Post media">`;

    if (!locked) {
      return `<div class="mediaWrap">${mediaEl}</div>`;
    }

    const creator = post.creator_username || post.creator_name || "creator";
    const profileUrl = `creator-profile.html?u=${encodeURIComponent(creator)}`;

    return `
      <div class="mediaWrap blurred">
        ${mediaEl}
        <div class="lockOverlay">
          <div class="op-badge op-badge--locked">Locked</div>
          <a class="navBtn primary" href="${esc(profileUrl)}">Open creator</a>
        </div>
      </div>
    `;
  }

  function defaultPostUrl(post) {
    return `/post.html?id=${encodeURIComponent(post.id)}`;
  }

  /**
   * post: { id, creator_username, title, content|excerpt, price_cents, currency, is_locked }
   */
  function renderPostCard(post, opts = {}) {
    const postUrl = (opts.postUrl || defaultPostUrl)(post);
    const title = esc(post.title || "Post");
    const excerpt = esc(post.excerpt || post.content || "");
    const creator = esc(post.creator_username || post.creator_name || "");
    const locked = Boolean(post.is_locked);
    const media = mediaHtml(post, locked);

    const price =
      post.price_cents != null && Number(post.price_cents) > 0
        ? fmtMoney(post.price_cents, post.currency || "eur")
        : "";

    const badge = locked
      ? `<span class="op-badge op-badge--locked">Locked</span>`
      : price
        ? `<span class="op-badge">${price}</span>`
        : `<span class="op-badge op-badge--free">Free</span>`;

    const likeBlock = FEATURE_LIKES
      ? `
        <button class="op-likeBtn" type="button" aria-label="Like" data-post-id="${esc(post.id)}" data-liked="0">
          <span class="op-likeIcon" aria-hidden="true">♡</span>
          <span class="op-likeCount" data-like-count>—</span>
        </button>
      `
      : "";

    return `
      <article class="op-postCard" data-post-id="${esc(post.id)}">
        <a class="op-postMain" href="${esc(postUrl)}">
          <div class="op-postTop">
            ${opts.showCreator !== false && creator ? `<span class="op-creator">@${creator}</span>` : `<span></span>`}
            <div class="op-topRight">${badge}</div>
          </div>

          <h3 class="op-title">${title}</h3>
          ${excerpt ? `<p class="op-excerpt">${excerpt}</p>` : ``}
          ${media}
        </a>

        <div class="op-postBottom">
          ${likeBlock}
        </div>
      </article>
    `.trim();
  }

  async function isLoggedIn() {
    try {
      const { data } = await window.onlypawsClient.auth.getSession();
      return Boolean(data?.session?.user?.id);
    } catch {
      return false;
    }
  }

  function setLiked(btn, liked) {
    btn.dataset.liked = liked ? "1" : "0";
    const icon = btn.querySelector(".op-likeIcon");
    if (icon) icon.textContent = liked ? "♥" : "♡";
    btn.classList.toggle("op-liked", liked);
  }

  function setCount(btn, count) {
    const el = btn.querySelector("[data-like-count]");
    if (el) el.textContent = String(count ?? "—");
  }

  async function hydrateLikeButton(btn, logged) {
    const postId = btn.dataset.postId;
    if (!postId) return;

    try {
      const c = await window.onlypawsLikes.getPostLikeCount(postId);
      setCount(btn, c);
    } catch {
      setCount(btn, "—");
    }

    if (!logged) return;

    try {
      const liked = await window.onlypawsLikes.getPostLikedByMe(postId);
      setLiked(btn, liked);
    } catch {
      // ignore
    }
  }

  function bindLikeButton(btn, logged) {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!logged) {
        alert("Login required");
        return;
      }

      btn.disabled = true;

      const prevLiked = btn.dataset.liked === "1";
      const prevCountText = btn.querySelector("[data-like-count]")?.textContent ?? "—";
      const prevCount = prevCountText !== "—" ? Number(prevCountText) : NaN;

      // optimistic
      setLiked(btn, !prevLiked);
      if (Number.isFinite(prevCount)) setCount(btn, prevLiked ? prevCount - 1 : prevCount + 1);

      try {
        const res = await window.onlypawsLikes.togglePostLike(btn.dataset.postId);
        setLiked(btn, res.liked);
        setCount(btn, res.like_count);
      } catch (err) {
        // rollback
        setLiked(btn, prevLiked);
        setCount(btn, prevCountText);
        console.error("toggle like failed", err);
        alert("Like failed");
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function initPostCards(root = document) {
    if (!FEATURE_LIKES) return;
    if (!window.onlypawsLikes || !window.onlypawsClient) {
      console.warn("Load supabase.likes.js before post-card.js");
      return;
    }

    const logged = await isLoggedIn();
    const buttons = $$(".op-likeBtn", root);

    await Promise.all(
      buttons.map(async (btn) => {
        await hydrateLikeButton(btn, logged);
        bindLikeButton(btn, logged);
      })
    );
  }

  function injectStyles() {
    if (document.getElementById("op-postcard-css")) return;
    const s = document.createElement("style");
    s.id = "op-postcard-css";
    s.textContent = `
      .op-postCard{
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.08);
        overflow: hidden;
      }
      .op-postMain{display:block;padding:14px 14px 10px;color:inherit;text-decoration:none}
      .op-postTop{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
      .op-creator{font-size:12px;opacity:.9;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width: 60%;}
      .op-topRight{display:flex;gap:8px;align-items:center;justify-content:flex-end}
      .op-badge{
        font-size: 11px;
        font-weight: 900;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(0,0,0,.18);
        white-space:nowrap;
      }
      .op-badge--locked{background: rgba(0,0,0,.30)}
      .op-title{margin:0;font-size:15px;font-weight:950;letter-spacing:.2px}
      .op-excerpt{margin:8px 0 0;font-size:13px;opacity:.9;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.mediaWrap{
        margin-top:12px;border-radius:18px;overflow:hidden;border:1px solid rgba(255,255,255,.14);
        background:rgba(0,0,0,.18);position:relative;
      }
      .mediaWrap img,.mediaWrap video{width:100%;display:block;max-height:460px;object-fit:cover;}
      .lockOverlay{
        position:absolute; inset:0;
        display:flex; align-items:center; justify-content:center;
        gap:10px; flex-direction:column;
        background: rgba(0,0,0,.45);
        backdrop-filter: blur(2px);
        padding:18px;
        text-align:center;
      }
      .blurred img, .blurred video{
        filter: blur(18px);
        transform: scale(1.03);
      }
      .navBtn{
        display:inline-flex;align-items:center;justify-content:center;
        gap:8px;
        padding:10px 14px;
        border-radius:999px;
        font-weight:900;
        text-decoration:none;
        border:1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.92);
        color: rgba(107,78,255,1);
      }
      .op-postBottom{display:flex;justify-content:flex-end;padding:10px 12px;border-top:1px solid rgba(255,255,255,.10)}
      .op-likeBtn{
        display:inline-flex;align-items:center;gap:8px;
        padding:8px 10px;border-radius:999px;
        border:1px solid rgba(255,255,255,.14);
        background: rgba(0,0,0,.15);
        color: inherit;
        cursor:pointer;
        user-select:none;
      }
      .op-likeBtn:disabled{opacity:.6;cursor:default}
      .op-likeIcon{font-size:14px;line-height:1}
      .op-likeCount{font-size:12px;font-weight:900;opacity:.95;min-width: 16px;text-align:right}
    `;
    document.head.appendChild(s);
  }

  injectStyles();

  window.OnlyPawsPostCard = {
    renderPostCard,
    initPostCards,
    FEATURE_LIKES,
  };
})();
