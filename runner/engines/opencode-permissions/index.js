// OpenCode V2 Promise plugin API. Keep approval routing active even when the
// owner's config, a saved grant, or a resumed session would otherwise allow it.
// Full access is answered by AcpEngine; Ask and Auto go through the runner.
export default {
  id: "perry.approvals",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", (event) => {
      if (event.effect !== "deny") event.effect = "ask";
    });
  },
};
