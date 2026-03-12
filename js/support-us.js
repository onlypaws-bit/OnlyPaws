window.initSupportUsButton = async function initSupportUsButton(options = {}) {
  const {
    buttonId = "supportUsBtn",
    messageId = "supportUsMsg",
    successPath = "/thank-you.html",
    cancelPath = window.location.pathname || "/",
    supportLabel = "Support OnlyPaws 🐾",
    cancelLabel = "Cancel support",
    resumeLabel = "Resume support"
  } = options;

  const btn = document.getElementById(buttonId);
  const msg = document.getElementById(messageId);

  if (!btn) return;

  const activeStatuses = ["trialing", "active", "past_due", "unpaid"];

  function setMsg(text) {
    if (msg) msg.textContent = text || "";
  }

  function setButton(label, disabled = false) {
    btn.textContent = label;
    btn.disabled = disabled;
  }

  async function goCheckout() {
    setButton(btn.textContent, true);
    setMsg("Redirecting to Stripe...");

    try {
      const { data, error } = await onlypawsClient.functions.invoke("support-us-checkout", {
        body: {
          successPath,
          cancelPath
        }
      });

      if (error) {
        setMsg("❌ " + (error.message || "Unable to start checkout."));
        setButton(supportLabel, false);
        return;
      }

      if (data?.url) {
        window.location.href = data.url;
        return;
      }

      setMsg("❌ Missing checkout URL.");
      setButton(supportLabel, false);
    } catch (err) {
      setMsg("❌ " + (err?.message || String(err)));
      setButton(supportLabel, false);
    }
  }

  async function cancelSupport() {
    setButton(cancelLabel, true);
    setMsg("Canceling...");

    try {
      const { error } = await onlypawsClient.functions.invoke("support-us-cancel");

      if (error) {
        setMsg("❌ " + (error.message || "Unable to cancel support."));
        setButton(cancelLabel, false);
        return;
      }

      setMsg("Support will cancel at period end.");
      setButton(resumeLabel, false);
      btn.onclick = resumeSupport;
    } catch (err) {
      setMsg("❌ " + (err?.message || String(err)));
      setButton(cancelLabel, false);
    }
  }

  async function resumeSupport() {
    setButton(resumeLabel, true);
    setMsg("Resuming...");

    try {
      const { error } = await onlypawsClient.functions.invoke("support-us-resume");

      if (error) {
        setMsg("❌ " + (error.message || "Unable to resume support."));
        setButton(resumeLabel, false);
        return;
      }

      setMsg("Support resumed 💜");
      setButton(cancelLabel, false);
      btn.onclick = cancelSupport;
    } catch (err) {
      setMsg("❌ " + (err?.message || String(err)));
      setButton(resumeLabel, false);
    }
  }

  setButton(supportLabel, false);

  try {
    const { data: sessionData } = await onlypawsClient.auth.getSession();
    const user = sessionData?.session?.user;

    // Guest users can support without logging in.
    if (!user) {
      btn.onclick = goCheckout;
      return;
    }

    const { data: support, error } = await onlypawsClient
      .from("support_us")
      .select("status, cancel_at_period_end")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("support_us read error:", error);
      setMsg("Could not load support status.");
      btn.onclick = goCheckout;
      return;
    }

    if (!support) {
      btn.onclick = goCheckout;
      return;
    }

    if (
      activeStatuses.includes(support.status) &&
      support.cancel_at_period_end === false
    ) {
      setButton(cancelLabel, false);
      btn.onclick = cancelSupport;
      return;
    }

    if (
      activeStatuses.includes(support.status) &&
      support.cancel_at_period_end === true
    ) {
      setButton(resumeLabel, false);
      btn.onclick = resumeSupport;
      return;
    }

    btn.onclick = goCheckout;
  } catch (err) {
    console.error("initSupportUsButton error:", err);
    setMsg("Could not load support status.");
    setButton(supportLabel, false);
    btn.onclick = goCheckout;
  }
};
