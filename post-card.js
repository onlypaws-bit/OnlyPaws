// post-card.js
// UI + binding LIKE riutilizzabile per i post
// Dipendenze global:
// - window.onlypawsClient
// - window.onlypawsLikes

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

  function isVideoMedia(mediaType, mediaUrl) {
    const mt = String(mediaType || "").toLowerCase();
    if (mt.startsWith("video")) return true;

    const url = String(mediaUrl || "").toLowerCase();
    return (
      url.endsWith(".mp4") ||
      url.endsWith(".webm") ||
      url.endsWith(".mov") ||
      url.endsWith(".m4v")
    );
  }

  function defaultPostUrl(post) {
    return `post.html?id=${encodeURIComponent(post.id)}`;
  }

  function creatorProfileUrl(username) {
    return `creator-profile.html?u=${encodeURIComponent(username || "creator")}`;
  }

  function mediaHtml(post, locked) {
    const url = post?.media_url;
    if (!url) return "";

    const isVideo = isVideoMedia(post.media_type, url);

    const mediaEl = isVideo
      ? `<video ${locked ? "" : "controls"} playsinline preload="metadata" src="${esc(url)}"></video>`
      : `<img src="${esc(url)}" alt="Post media" loading="lazy" decoding="async">`;

    if (!locked) {
      return `
        <div class="op-mediaWrap">
          ${mediaEl}
        </div>
      `;
    }

    const creator = post.creator_username || post.creator_name || "creator";
    const profileUrl = creatorProfileUrl(creator);

    return `
      <div class="op-mediaWrap op-isLocked">
        ${mediaEl}
        <div class="op-lockOverlay">
          <div class="op-lockBox">
            <div class="op-badge op-badge--locked">Locked</div>
            <p class="op-lockTitle">Premium post</p>
            <p class="op-lockText">Subscribe to unlock this content</p>
            <a class="op-openCreatorBtn" href="${esc(profileUrl)}" data-op-stop-nav="1">Open creator</a>
          </div>
        </div>
      </div>
    `;
  }

function formatPostDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const now = new Date();
  const diffMs = now - d;

  const min = Math.floor(diffMs / 60000);
  const hr = Math.floor(diffMs / 3600000);
  const day = Math.floor(diffMs / 86400000);

  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (hr < 24) return `${hr}h`;
  if (day < 7) return `${day}d`;

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

  function renderBadge(post, locked) {
    const price =
      post.price_cents != null && Number(post.price_cents) > 0
        ? fmtMoney(post.price_cents, post.currency || "eur")
        : "";

    if (locked) {
      return `<span class="op-badge op-badge--locked">Locked</span>`;
    }

    if (price) {
      return `<span class="op-badge op-badge--price">${esc(price)}</span>`;
    }

    return `<span class="op-badge op-badge--free">Free</span>`;
  }

  /**
   * post:
   * {
   *   id,
   *   creator_username,
   *   creator_name,
   *   creator_avatar_url,
   *   title,
   *   excerpt|content,
   *   price_cents,
   *   currency,
   *   is_locked,
   *   media_url,
   *   media_type
   * }
   */
  function renderPostCard(post, opts = {}) {
    const postUrl = (opts.postUrl || defaultPostUrl)(post);
    const title = esc(post.title || "");
    const excerpt = esc(post.excerpt || post.content || "");
    const creator = esc(post.creator_username || post.creator_name || "");
    const creatorAvatar = esc(post.creator_avatar_url || "");
const createdAt = formatPostDate(post.created_at);
    const locked = Boolean(post.is_locked);
    const media = mediaHtml(post, locked);
    const badge = renderBadge(post, locked);

    const avatarHtml = creatorAvatar
      ? `<img src="${creatorAvatar}" alt="${creator || "Creator"} avatar" loading="lazy" decoding="async">`
      : `<span aria-hidden="true">🐾</span>`;

    const likeBlock = FEATURE_LIKES
      ? `
        <button
          class="op-likeBtn"
          type="button"
          aria-label="Like post"
          data-post-id="${esc(post.id)}"
          data-liked="0"
          data-op-stop-nav="1"
        >
          <span class="op-likeIcon" aria-hidden="true">♡</span>
          <span class="op-likeCount" data-like-count>—</span>
        </button>
      `
      : "";

    return `
      <article class="op-postCard" data-post-id="${esc(post.id)}">
        <div
          class="op-postMain"
          role="link"
          tabindex="0"
          data-post-url="${esc(postUrl)}"
        >
          <div class="op-postHeader">
            <div class="op-postUser">
              <a
                class="op-avatar"
                href="${esc(creatorProfileUrl(creator))}"
                data-op-stop-nav="1"
                aria-label="Open ${creator || "creator"} profile"
              >
                ${avatarHtml}
              </a>

              <div class="op-userMeta">
  ${
    opts.showCreator !== false && creator
      ? `<a class="op-creator" href="${esc(creatorProfileUrl(creator))}" data-op-stop-nav="1">@${creator}</a>`
      : `<span class="op-creatorPlaceholder"></span>`
  }
  ${createdAt ? `<span class="op-postDate">${esc(createdAt)}</span>` : ``}
</div>
            </div>

            <div class="op-postHeaderRight">
              ${badge}
            </div>
          </div>

          ${title ? `<h3 class="op-title">${title}</h3>` : ``}
          ${excerpt ? `<p class="op-excerpt">${excerpt}</p>` : ``}
          ${media}
        </div>

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
    btn.classList.toggle("op-liked", liked);

    const icon = btn.querySelector(".op-likeIcon");
    if (icon) icon.textContent = liked ? "♥" : "♡";
  }

  function setCount(btn, count) {
    const el = btn.querySelector("[data-like-count]");
    if (!el) return;
    el.textContent = String(count ?? "—");
  }

  async function hydrateLikeButton(btn, logged) {
    const postId = btn.dataset.postId;
    if (!postId) return;

    try {
      const count = await window.onlypawsLikes.getPostLikeCount(postId);
      setCount(btn, count);
    } catch (err) {
      console.warn("getPostLikeCount failed", postId, err);
      setCount(btn, "—");
    }

    if (!logged) {
      setLiked(btn, false);
      return;
    }

    try {
      const liked = await window.onlypawsLikes.getPostLikedByMe(postId);
      setLiked(btn, liked);
    } catch (err) {
      console.warn("getPostLikedByMe failed", postId, err);
    }
  }

  function bindLikeButton(btn, logged) {
    if (btn.dataset.likeBound === "1") return;
    btn.dataset.likeBound = "1";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!logged) {
        alert("Login required");
        return;
      }

      if (btn.disabled) return;
      btn.disabled = true;

      const prevLiked = btn.dataset.liked === "1";
      const prevCountText = btn.querySelector("[data-like-count]")?.textContent ?? "—";
      const prevCount = prevCountText !== "—" ? Number(prevCountText) : NaN;

      setLiked(btn, !prevLiked);
      if (Number.isFinite(prevCount)) {
        setCount(btn, prevLiked ? prevCount - 1 : prevCount + 1);
      }

      try {
        const res = await window.onlypawsLikes.togglePostLike(btn.dataset.postId);
        setLiked(btn, Boolean(res?.liked));
        setCount(btn, Number(res?.like_count ?? 0));
      } catch (err) {
        setLiked(btn, prevLiked);
        setCount(btn, prevCountText);
        console.error("toggle like failed", err);
        alert("Like failed");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function bindPostNavigation(root = document) {
    const mains = $$(".op-postMain", root);

    mains.forEach((main) => {
      if (main.dataset.navBound === "1") return;
      main.dataset.navBound = "1";

      const go = () => {
        const url = main.dataset.postUrl;
        if (url) window.location.href = url;
      };

      main.addEventListener("click", (e) => {
        if (e.target.closest("[data-op-stop-nav='1']")) return;
        if (e.target.closest("a, button, input, textarea, select, label")) return;
        go();
      });

      main.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("[data-op-stop-nav='1']")) return;
        e.preventDefault();
        go();
      });
    });
  }

  async function initPostCards(root = document) {
    bindPostNavigation(root);

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
        border-radius:18px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.08);
        overflow:hidden;
      }

      .op-postMain{
        display:block;
        padding:14px;
        color:inherit;
        text-decoration:none;
        cursor:pointer;
        outline:none;
      }

      .op-postMain:focus-visible{
        outline:2px solid rgba(255,255,255,.45);
        outline-offset:-2px;
      }

      .op-postHeader{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:10px;
      }

      .op-postUser{
        min-width:0;
        display:flex;
        align-items:center;
        gap:10px;
      }

      .op-avatar{
        width:40px;
        height:40px;
        border-radius:999px;
        overflow:hidden;
        flex:0 0 auto;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,.18);
        border:1px solid rgba(255,255,255,.14);
        color:inherit;
        text-decoration:none;
        font-size:18px;
      }

      .op-avatar img{
        width:100%;
        height:100%;
        display:block;
        object-fit:cover;
      }

      .op-userMeta{
        min-width:0;
        display:flex;
        flex-direction:column;
        justify-content:center;
      }

      .op-creator{
        font-size:13px;
        opacity:.95;
        font-weight:900;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        color:inherit;
        text-decoration:none;
      }

      .op-creator:hover{
        text-decoration:underline;
      }

      .op-creatorPlaceholder{
        display:block;
        width:1px;
        height:13px;
      }

      .op-postHeaderRight{
        display:flex;
        align-items:center;
        gap:8px;
        flex:0 0 auto;
      }

      .op-badge{
        font-size:11px;
        font-weight:900;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(0,0,0,.18);
        white-space:nowrap;
      }

      .op-badge--locked{
        background:rgba(0,0,0,.30);
      }

      .op-badge--free{
        background:rgba(255,255,255,.10);
      }

      .op-badge--price{
        background:rgba(0,0,0,.18);
      }

      .op-title{
        margin:0 0 6px;
        font-size:15px;
        font-weight:950;
        letter-spacing:.2px;
        line-height:1.3;
      }

      .op-excerpt{
        margin:0 0 10px;
        font-size:14px;
        opacity:.92;
        line-height:1.45;
        display:-webkit-box;
        -webkit-line-clamp:3;
        -webkit-box-orient:vertical;
        overflow:hidden;
      }

      .op-mediaWrap{
        margin-top:8px;
        border-radius:14px;
        overflow:hidden;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(0,0,0,.18);
        position:relative;
      }

      .op-mediaWrap img,
      .op-mediaWrap video{
        width:100%;
        display:block;
        max-height:520px;
        object-fit:cover;
      }

      .op-mediaWrap.op-isLocked img,
      .op-mediaWrap.op-isLocked video{
        filter:blur(18px);
        transform:scale(1.03);
      }

      .op-lockOverlay{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:18px;
        background:rgba(0,0,0,.40);
        backdrop-filter:blur(2px);
      }

      .op-lockBox{
        width:100%;
        max-width:260px;
        padding:16px;
        text-align:center;
        border-radius:18px;
        background:rgba(18,18,30,.42);
        border:1px solid rgba(255,255,255,.14);
        backdrop-filter:blur(10px);
      }


      .op-lockTitle{
        margin:10px 0 6px;
        font-size:15px;
        font-weight:900;
      }

      .op-lockText{
        margin:0 0 12px;
        font-size:13px;
        line-height:1.35;
        opacity:.9;
      }

.op-postDate{
  font-size:12px;
  opacity:.72;
  margin-top:2px;
  white-space:nowrap;
}

      .op-openCreatorBtn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:8px;
        padding:10px 14px;
        border-radius:999px;
        font-weight:900;
        text-decoration:none;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.92);
        color:rgba(107,78,255,1);
      }

      .op-postBottom{
        display:flex;
        justify-content:flex-start;
        padding:10px 14px;
        border-top:1px solid rgba(255,255,255,.10);
      }

      .op-likeBtn{
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:8px 10px;
        border-radius:999px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(0,0,0,.15);
        color:inherit;
        cursor:pointer;
        user-select:none;
      }

      .op-likeBtn:disabled{
        opacity:.6;
        cursor:default;
      }

      .op-likeIcon{
        font-size:14px;
        line-height:1;
      }

      .op-likeCount{
        font-size:12px;
        font-weight:900;
        opacity:.95;
        min-width:16px;
        text-align:right;
      }

      .op-liked{
        background:rgba(255,255,255,.14);
      }
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
