// feed.js
async function fetchCreatorFeed(creatorId) {
  const supabase = window.onlypawsClient;

  // session + viewer
  const { data: { session } } = await supabase.auth.getSession();
  const viewerId = session?.user?.id || null;
  const isCreatorViewingOwnFeed = !!viewerId && viewerId === creatorId;

  // subscription check (only meaningful if logged and not the creator)
  let isSub = false;
  if (session && !isCreatorViewingOwnFeed) {
    const { data, error } = await supabase.rpc("is_subscribed_to", {
      p_creator_id: creatorId,
    });
    if (error) throw error;
    isSub = !!data;
  }

  const { data: posts, error: postsErr } = await supabase
    .from("posts")
    .select(
      "id, creator_id, pet_id, title, content, preview, slug, media_url, media_type, is_public, is_paid, is_pinned, likes_count, created_at"
    )
    .eq("creator_id", creatorId)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false });

  if (postsErr) throw postsErr;

  const enriched = (posts || []).map((p) => {
    const isMine = isCreatorViewingOwnFeed;

    // Rule 1: Private post => only creator
    if (p.is_public === false) {
      const can_view = isMine;
      return { ...p, can_view, is_locked: !can_view };
    }

    // From here: public posts
    // Rule 2: Free public => everyone (viewer in this page can still be null)
    if (p.is_paid !== true) {
      return { ...p, can_view: true, is_locked: false };
    }

    // Rule 3: Premium public => creator OR subscriber
    const can_view = isMine || isSub;
    return { ...p, can_view, is_locked: !can_view };
  });

  return { isSub, posts: enriched };
}

// export globale (se lavori senza bundler)
window.fetchCreatorFeed = fetchCreatorFeed;

// --- Featured creators (4-6 slots) ---
// Pulls a mix of latest-active and newest creators, then applies a deterministic daily shuffle.
async function fetchFeaturedCreators(limit = 6) {
  const supabase = window.onlypawsClient;

  const halfTop = Math.ceil(limit / 2);
  const halfNew = Math.floor(limit / 2);

  // Latest active creators
  const { data: latest, error: err1 } = await supabase
    .from("profiles")
    .select("id, username, avatar_url, created_at, last_active_at")
    .eq("role", "creator")
    .order("last_active_at", { ascending: false })
    .limit(halfTop);

  if (err1) throw err1;

  // Newest creators
  const { data: newest, error: err2 } = await supabase
    .from("profiles")
    .select("id, username, avatar_url, created_at, last_active_at")
    .eq("role", "creator")
    .order("created_at", { ascending: false })
    .limit(halfNew);

  if (err2) throw err2;

  // Merge + de-dup
  const map = new Map();
  [...(latest || []), ...(newest || [])].forEach((c) => {
    if (c?.id && !map.has(c.id)) map.set(c.id, c);
  });

  const merged = Array.from(map.values());

  // If very few creators exist, just return them
  if (merged.length <= limit) return merged;

  // Deterministic daily shuffle (changes once per day)
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const seedStr = today.replace(/-/g, "");

  function seededRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    }
    return () => {
      h = (Math.imul(1664525, h) + 1013904223) | 0;
      return (h >>> 0) / 4294967296;
    };
  }

  const rand = seededRandom(seedStr);

  // Fisher-Yates shuffle using seeded RNG
  for (let i = merged.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = merged[i];
    merged[i] = merged[j];
    merged[j] = tmp;
  }

  return merged.slice(0, limit);
}

// export globale (se lavori senza bundler)
window.fetchFeaturedCreators = fetchFeaturedCreators;
