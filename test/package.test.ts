import { describe, expect, it } from "vitest";

import { RasketApi } from "../credentials/RasketApi.credentials";
import { PACKAGE_VERSION, USER_AGENT } from "../nodes/Rasket/transport";
import pkg from "../package.json";

/**
 * The parts of package.json n8n's verification and loader depend on. `pnpm run scan` checks the
 * packed copy; this checks the source of it.
 */

describe("package.json", () => {
  it("is the community package n8n expects", () => {
    expect(pkg.name).toBe("n8n-nodes-rasket");
    expect(pkg.keywords).toContain("n8n-community-node-package");
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).toBe(false);
    expect(pkg.files).toStrictEqual(["dist"]);
    expect(pkg).not.toHaveProperty("type");
  });

  it("has no runtime dependencies, and n8n-workflow only as a peer", () => {
    expect(pkg).not.toHaveProperty("dependencies");
    expect(pkg.peerDependencies).toStrictEqual({ "n8n-workflow": "*" });
  });

  it("has no install-time scripts", () => {
    for (const script of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublish",
      "prepack",
    ]) {
      expect(pkg.scripts).not.toHaveProperty(script);
    }
  });

  it("registers the compiled node and credential files in strict mode", () => {
    expect(pkg.n8n).toStrictEqual({
      n8nNodesApiVersion: 1,
      strict: true,
      credentials: ["dist/credentials/RasketApi.credentials.js"],
      nodes: ["dist/nodes/Rasket/Rasket.node.js", "dist/nodes/RasketTrigger/RasketTrigger.node.js"],
    });
  });

  it("sends its own version in the User-Agent", () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`n8n-nodes-rasket/${pkg.version}`);
  });
});

describe("credential", () => {
  it("sends the API key as a bearer token and tests it with GET /team", () => {
    const credential = new RasketApi();
    expect(credential.name).toBe("rasketApi");
    expect(credential.properties[0]).toMatchObject({
      name: "apiKey",
      typeOptions: { password: true },
    });
    expect(credential.authenticate).toStrictEqual({
      type: "generic",
      properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } },
    });
    expect(credential.test.request).toMatchObject({
      baseURL: "https://api.rasket.com",
      url: "/team",
    });
  });
});
