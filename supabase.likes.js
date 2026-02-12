// supabase.likes.fixed.js
// Reuses window.onlypawsClient if present; otherwise creates it.
(() => {
  const SUPABASE_URL = "https://sdhpbwkhdovyunvtdtbq.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkaHBid2toZG92eXVudnRkdGJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NTU1NDMsImV4cCI6MjA4NTUzMTU0M30.QuEhO3G7U0ScHrHqgIGnwm0uqtlfs2qXvGXPh1UKsRo";

  if (!window.supabase) {
    throw new Error(
      "Supabase JS non caricato. Metti prima: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
    );
  }

  const client =
    window.onlypawsClient ||
    window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
      },
    });

  window.onlypawsClient = client;

  async function getPostLikedByMe(postId) {
    if (!postId) throw new Error("getPostLikedByMe: missing postId");
    const { data, error } = await client.rpc("get_post_liked_by_me", { p_post_id: postId });
    if (error) throw error;
    return Boolean(data);
  }


  async function getPostLikeCount(postId) {
    if (!postId) throw new Error("getPostLikeCount: missing postId");
    // Fast path: read denormalized counter from posts table
    const { data, error } = await client
      .from("posts")
      .select("likes_count")
      .eq("id", postId)
      .maybeSingle();
    if (error) throw error;
    return Number(data?.likes_count ?? 0);
  }

  async function togglePostLike(postId) {
    if (!postId) throw new Error("togglePostLike: missing postId");
    const { data, error } = await client.rpc("toggle_post_like", { p_post_id: postId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      liked: Boolean(row?.liked),
      like_count: Number(row?.like_count ?? 0),
    };
  }

  window.onlypawsLikes = { getPostLikedByMe, getPostLikeCount, togglePostLike };
  console.log("✅ onlypawsLikes ready");
})();
