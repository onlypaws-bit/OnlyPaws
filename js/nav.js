function show(el, yes){
  if(!el) return;
  el.style.display = yes ? "inline-flex" : "none";
}

async function hydrateUserPill(){
  const pill = document.getElementById("userPill");
  if(!pill) return;

  const { data } = await onlypawsClient.auth.getSession();
  const session = data?.session;

  if(!session){
    pill.textContent = "Guest";
    return;
  }

  const uid = session.user.id;

  const { data: prof } = await onlypawsClient
    .from("profiles")
    .select("username, display_name")
    .eq("user_id", uid)
    .maybeSingle();

  pill.textContent =
    prof?.username
      ? "@" + prof.username
      : prof?.display_name || "User";
}

async function hydrateNav(){
  const { data } = await onlypawsClient.auth.getUser();
  const userId = data?.user?.id;
  if(!userId) return;

  const { data: p } = await onlypawsClient
    .from("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  show(document.getElementById("navProfile"), true);
  show(document.getElementById("navLogout"), true);

  if(p?.role === "creator"){
    show(document.getElementById("navCreatorDash"), true);
  } else {
    show(document.getElementById("navFanDash"), true);
  }
}

function setupLogout(){
  const btn = document.getElementById("navLogout");
  if(!btn) return;

  btn.addEventListener("click", async () => {
    await onlypawsClient.auth.signOut();
    window.location.replace("index.html");
  });
}

async function initNav(){
  await hydrateUserPill();
  await hydrateNav();
  setupLogout();
}