import cliPackage from "../../../package.json";

/**
 * The pi release marcsh runs on. Read from marcsh's own exact dependency pin (the lockfile is frozen to it),
 * not from pi's package: pi does not export its package.json, and loading pi here would load it before
 * PI_CODING_AGENT_DIR is set (see pi.ts).
 */
export const PI_VERSION: string = cliPackage.dependencies["@earendil-works/pi-coding-agent"];
