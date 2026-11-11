// Wraps every rule that uses :hover in @media (hover: hover), so hover styles only apply on
// devices with a real pointer. On phones and tablets a tap otherwise "sticks" the hover
// state (white inverted cards and buttons, lifted rows) until the next tap elsewhere.
//
// Runs on all site CSS (global stylesheets and component <style> blocks) at build time.
export default function hoverOnly() {
  return {
    postcssPlugin: "mp-hover-only",
    Rule(rule, { AtRule }) {
      if (!rule.selector || !rule.selector.includes(":hover")) return;

      // Leave keyframes and anything already inside a (hover: ...) media query alone.
      for (let p = rule.parent; p; p = p.parent) {
        if (p.type !== "atrule") continue;
        if (/keyframes/i.test(p.name)) return;
        if (p.name === "media" && /hover\s*:/i.test(p.params)) return;
      }

      const withHover = [];
      const without = [];
      for (const sel of rule.selectors) {
        (sel.includes(":hover") ? withHover : without).push(sel);
      }

      const hoverRule = rule.clone({ selectors: withHover });
      const wrap = new AtRule({ name: "media", params: "(hover: hover)" });
      wrap.append(hoverRule);

      if (without.length === 0) {
        rule.replaceWith(wrap);
      } else {
        rule.selectors = without;
        rule.after(wrap);
      }
    },
  };
}
hoverOnly.postcss = true;
