#!/usr/bin/env node
// Publish the current framework + scaffolder versions to the curb CDN
// (Cloudflare R2, served at https://cdn.kugelaudio.com/curb/). Packs both
// packages with `npm pack`, uploads the tarballs, then updates latest.json,
// the pointer `curb upgrade` and the update notice read.
//
// Requires S3 credentials scoped to the curb CDN bucket.
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/publish-cdn.mjs [--force] [--no-latest]

Packs packages/framework and packages/create-framework-app and uploads the
tarballs to R2 (bucket kugelaudio-public-cdn, keys curb/<name>.tgz), then
updates curb/latest.json and the stable aliases curb/create-curb-app.tgz (the
scaffold command is
npx --yes --allow-remote=all https://cdn.kugelaudio.com/curb/create-curb-app.tgz my-agent),
curb/create-curb-app-latest.tgz and curb/curb-latest.tgz.

Flags:
  --force      Overwrite tarballs that already exist on the CDN.
  --no-latest  Upload the tarballs but do not move latest.json or the stable aliases.
  --help       Print this message.
`;

const BUCKET = "kugelaudio-public-cdn";
const CDN_URL = "https://cdn.kugelaudio.com/curb";
const R2_REGION = "auto";
const R2_SERVICE = "s3";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
for (const arg of args) {
  if (arg !== "--force" && arg !== "--no-latest") {
    console.error(`Unknown flag "${arg}".\n\n${USAGE}`);
    process.exit(1);
  }
}
const force = args.includes("--force");
const skipLatest = args.includes("--no-latest");

const requiredEnv = [
  "CURB_CDN_R2_ACCESS_KEY_ID",
  "CURB_CDN_R2_SECRET_ACCESS_KEY",
  "CURB_CDN_R2_ACCOUNT_ID",
];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`publish-cdn: ${name} is not set.`);
    process.exit(1);
  }
}

const accessKeyId = process.env.CURB_CDN_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.CURB_CDN_R2_SECRET_ACCESS_KEY;
const r2Host = `${process.env.CURB_CDN_R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`publish-cdn: ${message}`);
  process.exit(1);
}

/** Run a command, streaming output; non-zero exit aborts the publish. */
function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (result.error) fail(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`\`${cmd} ${cmdArgs.join(" ")}\` exited with ${result.status}.`);
  return result;
}

/** Run a command capturing stdout (stderr still streams). */
function capture(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  });
  if (result.error) fail(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`\`${cmd} ${cmdArgs.join(" ")}\` exited with ${result.status}.`);
  return result.stdout;
}

function readManifest(packageDir) {
  const { name, version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (!name || !version) fail(`${packageDir}/package.json is missing name or version.`);
  return { name, version };
}

/** `npm pack` a package into destDir; verify the tarball npm reports is the predicted one. */
function pack(packageDir, destDir) {
  const { name, version } = readManifest(packageDir);
  // npm's tarball naming: @scope/pkg -> scope-pkg-<version>.tgz.
  const predicted = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  const stdout = capture("npm", ["pack", "--pack-destination", destDir], { cwd: packageDir });
  const lines = stdout.trim().split("\n").filter(Boolean);
  const actual = lines[lines.length - 1];
  if (actual !== predicted) {
    fail(`npm pack for ${name} produced "${actual}", expected "${predicted}". Refusing to guess.`);
  }
  return { name, version, tarball: predicted, path: join(destDir, predicted) };
}

/** An env file holds keys and must never reach the public CDN. */
function assertNoSecrets(tarballPath) {
  const listing = capture("tar", ["-tzf", tarballPath]);
  const leaked = listing.split("\n").filter((entry) => /(^|\/)[^/]*\.env(\.[^/]*)?$/.test(entry) && !entry.endsWith(".env.example"));
  if (leaked.length > 0) {
    fail(`${tarballPath} contains ${leaked.join(", ")}. Remove the env file and re-run.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

/** AWS URI encoding is stricter than encodeURIComponent for these characters. */
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(key) {
  return `/${uriEncode(BUCKET)}/${key.split("/").map(uriEncode).join("/")}`;
}

/** Sign and send an R2 S3 request without depending on a runner-global CLI. */
async function r2Request(method, key, { body = Buffer.alloc(0), contentType, cacheControl } = {}) {
  const payloadHash = sha256(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const path = canonicalPath(key);
  const headers = {
    host: r2Host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  if (cacheControl) headers["cache-control"] = cacheControl;

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, R2_REGION);
  const serviceKey = hmac(regionKey, R2_SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;

  return fetch(`https://${r2Host}${path}`, {
    method,
    headers: { ...headers, authorization },
    body: method === "HEAD" ? undefined : body,
  });
}

async function objectExists(key) {
  const response = await r2Request("HEAD", key);
  if (response.ok) return true;
  if (response.status === 404) return false;
  fail(`R2 could not check ${key}: HTTP ${response.status} ${response.statusText}.`);
}

async function upload(key, filePath, contentType, cacheControl) {
  const response = await r2Request("PUT", key, { body: readFileSync(filePath), contentType, cacheControl });
  if (!response.ok) {
    fail(`R2 could not upload ${key}: HTTP ${response.status} ${response.statusText}.`);
  }
}

/** The stable alias keys of a package: curb/<name>-latest.tgz, and for the scaffolder first
 * curb/create-curb-app.tgz, the quickstart's URL. */
function aliasKeys(pkg) {
  const name = pkg.name.replace(/^@/, "").replace("/", "-");
  return [...(name === "create-curb-app" ? [`curb/${name}.tgz`] : []), `curb/${name}-latest.tgz`];
}

const tmp = mkdtempSync(join(tmpdir(), "curb-publish-"));
try {
  const framework = pack(join(repoRoot, "packages", "framework"), tmp);
  const scaffolder = pack(join(repoRoot, "packages", "create-framework-app"), tmp);
  assertNoSecrets(scaffolder.path);

  for (const pkg of [framework, scaffolder]) {
    const key = `curb/${pkg.tarball}`;
    if (await objectExists(key)) {
      if (!force) {
        fail(
          `${key} already exists on the CDN. Bump the version in ${pkg.name}'s package.json, or pass --force to overwrite.`,
        );
      }
      console.log(`Overwriting existing ${key} (--force).`);
    }
    await upload(key, pkg.path, "application/gzip");
    console.log(`Uploaded ${key}`);
  }

  if (skipLatest) {
    console.log("Skipped latest.json (--no-latest).");
  } else {
    const latest = {
      version: framework.version,
      tarball: framework.tarball,
      createApp: { version: scaffolder.version, tarball: scaffolder.tarball },
      publishedAt: new Date().toISOString(),
    };
    const latestPath = join(tmp, "latest.json");
    writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    await upload("curb/latest.json", latestPath, "application/json");
    console.log("Uploaded curb/latest.json");

    // Stable URLs that always serve the newest tarball, so a documented command never
    // names a version: the scaffold command is `npx --yes --allow-remote=all <CDN>/create-curb-app.tgz`.
    // no-cache, because a cached alias would hand out the previous release.
    for (const pkg of [framework, scaffolder]) {
      for (const key of aliasKeys(pkg)) {
        await upload(key, pkg.path, "application/gzip", "no-cache");
        console.log(`Uploaded ${key}`);
      }
    }
  }

  console.log("\nPublished:");
  console.log(`  ${CDN_URL}/${framework.tarball}`);
  console.log(`  ${CDN_URL}/${scaffolder.tarball}`);
  if (!skipLatest) {
    console.log(`  ${CDN_URL}/latest.json`);
    for (const key of [framework, scaffolder].flatMap(aliasKeys)) console.log(`  ${CDN_URL}/${key.slice("curb/".length)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
