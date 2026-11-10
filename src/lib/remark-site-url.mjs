import { visit } from "unist-util-visit";
import { FALLBACK_SITE_URL } from "./site-url.mjs";

// Replaces %SITE_URL% in code blocks and inline code with the configured site URL, so docs
// can show `curl -fsSL %SITE_URL%/installer.sh | bash` and always match the deployed domain.
export function remarkSiteUrl(options = {}) {
  const url = options.siteUrl || FALLBACK_SITE_URL;
  return (tree) => {
    visit(tree, ["code", "inlineCode"], (node) => {
      if (typeof node.value === "string" && node.value.includes("%SITE_URL%")) {
        node.value = node.value.replaceAll("%SITE_URL%", url);
      }
    });
  };
}
