import { z } from 'zod';
import { defineTool, type AgentServices, type ToolContext, type ToolDef } from './tools/types.js';
import type { TokenAppSpec } from './tokenApps.js';
import { sandboxPath, shq } from './sandbox/index.js';
import { holdSecret } from './sandbox/secrets.js';
import { hide, log, sandboxNeeds, short, withSandbox } from './tools/sandbox.js';
import { revealLogin } from './vault.js';

/**
 * Expo (EAS Build): Orin builds iOS apps in Expo's cloud, so no Mac is needed.
 *
 * The user's Expo personal access token comes from the Apps page (Expo, checked with Expo before it is
 * saved, stored encrypted) or, failing that, from a Secure Vault login named EXPO_TOKEN (or one for
 * expo.dev). It is never shown to the model, never written into a project, and reaches eas-cli only as
 * the EXPO_TOKEN environment variable of the one command that needs it; command output is redacted.
 *
 * An Expo token is only the Expo account. A signed iOS build for real iPhones also needs Apple signing
 * credentials (a distribution certificate and provisioning profile from a paid Apple Developer account)
 * stored on Expo; a simulator build needs neither. Orin checks for those before she builds, never
 * creates accounts, never submits to the App Store, and linking a project or starting a cloud build
 * waits for the user's approval (a build uses the user's Expo plan allowance).
 */

export type ExpoAppId = 'expo';

const API = 'https://api.expo.dev/graphql';
const EAS = 'npx -y eas-cli@27';
const MARK = '@@ORIN_EXPO@@';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('Stopped.'))), { once: true });
  });

// ---------------------------------------------------------------- token

type Owner = { owner: string; services: AgentServices };

/** The token and where it came from, or null. Never logged or returned to the model. */
export function expoTokenOf(p: Owner): { token: string; source: 'apps' | 'vault' } | null {
  const c = p.services.store.getConnection(p.owner, 'expo');
  if (c?.accessToken) return { token: c.accessToken, source: 'apps' };
  try {
    const rows = p.services.store.listVault(p.owner);
    const row =
      rows.find((v) => /^expo[_ -]?(token|access[_ -]?token)$/i.test(v.name.trim())) ??
      rows.find((v) => /(^|\.)expo\.(dev|io)$/i.test(v.domain.trim().replace(/^\*\./, '')) && /token/i.test(v.name));
    if (row) {
      const { username, password } = revealLogin(row);
      const t = (password || username || '').trim();
      if (t) return { token: t, source: 'vault' };
    }
  } catch {
    /* vault unreadable: treat as not set */
  }
  return null;
}

function tokenFor(ctx: ToolContext): string {
  const t = expoTokenOf(ctx);
  if (!t) throw new Error('Expo is not connected. Ask the user to connect Expo on the Apps page (or save a Secure Vault login named EXPO_TOKEN).');
  holdSecret(ctx.owner, 'Expo token', t.token);
  return t.token;
}

export const EXPO_NEEDS = 'the user to connect Expo on the Apps page (tap Expo, paste a personal access token from expo.dev)';
const expoNeeds = (p: Owner) => (expoTokenOf(p) ? null : EXPO_NEEDS);
const expoAndSandboxNeeds = (p: Owner) => expoNeeds(p) ?? sandboxNeeds(p.services, p.owner);

// ---------------------------------------------------------------- Expo API

export async function expoGql<T>(svc: AgentServices, token: string, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const res = await svc.fetchImpl(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Orin-Agent' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const text = await res.text();
  let j: { data?: T; errors?: { message?: string; code?: string; extensions?: { errorCode?: string } }[] } = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expo answered HTTP ${res.status} with something that was not JSON.`);
  }
  const err = j.errors?.[0];
  if (res.status === 401 || res.status === 403 || err?.code === 'AUTHENTICATION_ERROR' || err?.extensions?.errorCode === 'UNAUTHORIZED_ERROR') {
    throw new Error(`Expo refused the token (${err?.message ?? `HTTP ${res.status}`}). It may be wrong, revoked or expired; connect Expo again on the Apps page.`);
  }
  if (err) throw new Error(`Expo: ${clip(err.message ?? 'error', 300)}`);
  if (!res.ok || !j.data) throw new Error(`Expo answered HTTP ${res.status}.`);
  return j.data;
}

export interface ExpoMe {
  kind: string;
  name: string;
  accounts: string[];
}

export async function expoWhoAmI(svc: AgentServices, token: string, signal: AbortSignal): Promise<ExpoMe> {
  const d = await expoGql<{ meActor: null | { __typename: string; username?: string; firstName?: string; accounts?: { name: string }[] } }>(
    svc,
    token,
    'query OrinMe { meActor { __typename id ... on UserActor { username } ... on Robot { firstName } accounts { id name } } }',
    {},
    signal,
  );
  if (!d.meActor) throw new Error('Expo refused the token (it is not signed in to any account). Connect Expo again on the Apps page.');
  const a = d.meActor;
  return { kind: a.__typename, name: a.username ?? a.firstName ?? 'robot', accounts: (a.accounts ?? []).map((x) => x.name) };
}

export const EXPO_APP: TokenAppSpec = {
  id: 'expo',
  name: 'Expo',
  description: 'Builds your iPhone (iOS) apps in Expo\'s cloud, no Mac needed; linking a project and every build ask you first.',
  tokenLabel: 'Personal access token',
  tokenHelp:
    'expo.dev → your account → Settings → Access tokens → Create token. This is your Expo account only: builds for real iPhones also need Apple signing set up on Expo (paid Apple Developer account); simulator builds do not.',
  tokenUrl: 'https://expo.dev/settings/access-tokens',
  verify: async (svc, token, signal) => {
    const me = await expoWhoAmI(svc, token, signal);
    return me.kind === 'Robot' ? `robot · ${me.accounts[0] ?? me.name}` : me.name;
  },
};

// ---------------------------------------------------------------- project inspection

export interface EasProfile {
  name: string;
  simulator: boolean;
  distribution: string;
  credentialsSource: string;
  enterpriseProvisioning?: string;
}

export interface ExpoProject {
  dir: string;
  isExpo: boolean;
  expoVersion: string | null;
  dynamicConfig: string | null;
  configResolved: boolean;
  name: string | null;
  slug: string | null;
  owner: string | null;
  projectId: string | null;
  bundleId: string | null;
  version: string | null;
  hasEasJson: boolean;
  profiles: EasProfile[];
  git: boolean;
  node: string | null;
  credentialsJson: boolean;
}

/** node script run in the project folder; prints one marked JSON line */
const INSPECT = `const fs=require('fs'),cp=require('child_process');const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return null}};const js=s=>{try{return s?JSON.parse(s):null}catch(e){return {__bad:true}}};
const r={};const pkg=js(rd('package.json'))||{};const deps=Object.assign({},pkg.dependencies||{},pkg.devDependencies||{});r.expoVersion=deps.expo||null;
r.appJson=js(rd('app.json'));r.dynamic=['app.config.ts','app.config.js','app.config.mjs','app.config.cjs'].find(f=>fs.existsSync(f))||null;
if(r.dynamic){try{r.resolved=JSON.parse(cp.execSync('npx --no-install expo config --json --type public',{stdio:['ignore','pipe','ignore'],timeout:120000}).toString())}catch(e){r.resolved=null}}
r.easJson=js(rd('eas.json'));r.git=fs.existsSync('.git');r.credentialsJson=fs.existsSync('credentials.json');r.node=process.version;console.log(${JSON.stringify(MARK)}+JSON.stringify(r));`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Turns the inspection JSON into what Orin needs to know. Pure, for tests. */
export function analyseProject(dir: string, raw: Json): ExpoProject {
  const appJson = obj(raw.appJson);
  const resolved = raw.resolved ? obj(raw.resolved) : null;
  // app.json is either { expo: {...} } or the config itself; `expo config` prints the config itself
  const cfg = resolved ?? (appJson.expo ? obj(appJson.expo) : appJson);
  const ios = obj(cfg.ios);
  const eas = obj(obj(cfg.extra).eas);
  const easJson = raw.easJson && !obj(raw.easJson).__bad ? obj(raw.easJson) : null;
  const builds = obj(easJson?.build);
  const resolveProfile = (name: string, seen: string[] = []): Json => {
    const p = obj(builds[name]);
    const parent = str(p.extends);
    if (!parent || seen.includes(parent)) return p;
    const base = resolveProfile(parent, [...seen, name]);
    return { ...base, ...p, ios: { ...obj(base.ios), ...obj(p.ios) } };
  };
  const profiles: EasProfile[] = Object.keys(builds).map((name) => {
    const p = resolveProfile(name);
    const pi = obj(p.ios);
    return {
      name,
      simulator: pi.simulator === true,
      distribution: str(p.distribution) ?? 'store',
      credentialsSource: str(p.credentialsSource) ?? 'remote',
      ...(str(pi.enterpriseProvisioning) ? { enterpriseProvisioning: str(pi.enterpriseProvisioning)! } : {}),
    };
  });
  return {
    dir,
    isExpo: Boolean(raw.expoVersion) || Boolean(appJson.expo) || Boolean(raw.dynamic),
    expoVersion: str(raw.expoVersion),
    dynamicConfig: str(raw.dynamic),
    configResolved: !raw.dynamic || Boolean(resolved),
    name: str(cfg.name),
    slug: str(cfg.slug),
    owner: str(cfg.owner),
    projectId: str(eas.projectId),
    bundleId: str(ios.bundleIdentifier),
    version: str(cfg.version),
    hasEasJson: Boolean(easJson),
    profiles,
    git: raw.git === true,
    node: str(raw.node),
    credentialsJson: raw.credentialsJson === true,
  };
}

async function inspectProject(ctx: ToolContext, path: string): Promise<ExpoProject> {
  const dir = sandboxPath(path);
  const cmd = `cd ${shq(dir)} 2>/dev/null || { echo NO_DIR; exit 4; }; command -v node >/dev/null || { echo NO_NODE; exit 5; }; node -e ${shq(INSPECT)}`;
  const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { timeoutMs: 3 * 60_000 })));
  if (r.exitCode === 4) throw new Error(`There is no folder ${dir} on your computer.`);
  if (r.exitCode === 5) throw new Error('Node.js is not installed on this computer, and Expo builds need it (install it first, e.g. with sandbox_run).');
  const line = r.stdout.split('\n').find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`Could not read the project in ${dir}: ${clip((r.stderr || r.stdout).trim(), 400)}`);
  return analyseProject(dir, JSON.parse(line.slice(MARK.length)) as Json);
}

// ---------------------------------------------------------------- signing

export type IosDistribution = 'APP_STORE' | 'AD_HOC' | 'ENTERPRISE';

export function distributionOf(p: EasProfile): IosDistribution | null {
  if (p.simulator) return null;
  if (p.distribution === 'store') return 'APP_STORE';
  return p.enterpriseProvisioning === 'universal' ? 'ENTERPRISE' : 'AD_HOC';
}

export interface SigningState {
  distribution: IosDistribution;
  certificate: { serial: string; validUntil: string; expired: boolean } | null;
  profile: { status: string; expires: string; expired: boolean } | null;
  ready: boolean;
}

/** Asks Expo whether signing credentials for this bundle id and distribution are stored. Never fetches the certificate itself. */
export async function iosSigning(svc: AgentServices, token: string, owner: string, fullName: string, bundleId: string, distribution: IosDistribution, signal: AbortSignal, now = Date.now()): Promise<SigningState> {
  const idq = await expoGql<{ account: { byName: { appleAppIdentifiers: { id: string }[] } } }>(
    svc,
    token,
    'query OrinAppleId($accountName: String!, $bundleIdentifier: String!) { account { byName(accountName: $accountName) { id appleAppIdentifiers(bundleIdentifier: $bundleIdentifier) { id bundleIdentifier } } } }',
    { accountName: owner, bundleIdentifier: bundleId },
    signal,
  );
  const appleId = idq.account?.byName?.appleAppIdentifiers?.[0]?.id;
  const none: SigningState = { distribution, certificate: null, profile: null, ready: false };
  if (!appleId) return none;
  const cq = await expoGql<{ app: { byFullName: { iosAppCredentials: { iosAppBuildCredentialsList: { distributionCertificate: { serialNumber: string; validityNotAfter: string } | null; provisioningProfile: { status: string; expiration: string } | null }[] }[] } } }>(
    svc,
    token,
    'query OrinIosCreds($projectFullName: String!, $appleAppIdentifierId: String!, $iosDistributionType: IosDistributionType!) { app { byFullName(fullName: $projectFullName) { id iosAppCredentials(filter: { appleAppIdentifierId: $appleAppIdentifierId }) { id iosAppBuildCredentialsList(filter: { iosDistributionType: $iosDistributionType }) { id distributionCertificate { id serialNumber validityNotAfter } provisioningProfile { id status expiration } } } } } }',
    { projectFullName: fullName, appleAppIdentifierId: appleId, iosDistributionType: distribution },
    signal,
  );
  const b = cq.app?.byFullName?.iosAppCredentials?.[0]?.iosAppBuildCredentialsList?.[0];
  if (!b) return none;
  const certificate = b.distributionCertificate
    ? { serial: b.distributionCertificate.serialNumber, validUntil: b.distributionCertificate.validityNotAfter, expired: Date.parse(b.distributionCertificate.validityNotAfter) < now }
    : null;
  const profile = b.provisioningProfile
    ? { status: b.provisioningProfile.status, expires: b.provisioningProfile.expiration, expired: Date.parse(b.provisioningProfile.expiration) < now || /expired|invalid/i.test(b.provisioningProfile.status) }
    : null;
  return { distribution, certificate, profile, ready: Boolean(certificate && !certificate.expired && profile && !profile.expired) };
}

export const APPLE_SIGNING_HELP = [
  'Builds for real iPhones (TestFlight, App Store, ad hoc installs) must be signed with Apple credentials, which an Expo token alone does not give:',
  '1. A paid Apple Developer Program membership (99 USD a year) — Orin cannot create or pay for it.',
  '2. Signing credentials stored on Expo: run `npx eas-cli credentials -p ios` once in a terminal you control, sign in to your Apple account when asked (with your 2-step code), and let EAS create the distribution certificate and provisioning profile. Or supply your own certificate and profile with a credentials.json (credentialsSource "local").',
  '3. For ad hoc ("internal") builds, register each iPhone first (`npx eas-cli device:create`).',
  'Submitting to the App Store is a separate step Orin does not do.',
  'Without any of this, a simulator build (profile with "ios": {"simulator": true}) works with just the Expo token.',
].join('\n');

// ---------------------------------------------------------------- report

export function blockersFor(p: ExpoProject, profileName?: string): string[] {
  const out: string[] = [];
  if (!p.isExpo) out.push('This folder is not an Expo project (no expo in package.json and no app.json "expo" config). Start from scaffold_project (Expo template) or `npx create-expo-app`.');
  if (p.dynamicConfig && !p.configResolved) out.push(`The app config is ${p.dynamicConfig} and could not be read; run npm install in the project first, then check again.`);
  if (!p.projectId) out.push('Not linked to an EAS project on your Expo account yet (no extra.eas.projectId). Run expo_setup_ios.');
  if (!p.bundleId) out.push('No iOS bundle identifier (expo.ios.bundleIdentifier, e.g. com.yourname.appname). Run expo_setup_ios with bundle_id.');
  if (!p.hasEasJson) out.push('No eas.json build profiles. Run expo_setup_ios.');
  if (profileName && p.hasEasJson && !p.profiles.some((x) => x.name === profileName)) out.push(`eas.json has no build profile "${profileName}" (it has: ${p.profiles.map((x) => x.name).join(', ') || 'none'}).`);
  return out;
}

function describeProject(p: ExpoProject): string {
  const prof = p.profiles.length
    ? p.profiles.map((x) => `  - ${x.name}: ${x.simulator ? 'iOS Simulator build (no Apple account needed)' : `${distributionOf(x) === 'APP_STORE' ? 'App Store/TestFlight' : distributionOf(x) === 'ENTERPRISE' ? 'enterprise' : 'ad hoc (internal)'} build for real iPhones — needs Apple signing${x.credentialsSource === 'local' ? ' (from credentials.json)' : ''}`}`).join('\n')
    : '  (none)';
  return [
    `Project: ${p.dir}`,
    `  Expo SDK: ${p.expoVersion ?? 'unknown'} · config: ${p.dynamicConfig ?? 'app.json'} · name: ${p.name ?? '?'} · slug: ${p.slug ?? '?'} · version: ${p.version ?? '?'}`,
    `  EAS project: ${p.projectId ?? 'not linked'}${p.owner ? ` (owner ${p.owner})` : ''} · iOS bundle id: ${p.bundleId ?? 'not set'} · git: ${p.git ? 'yes' : 'no (EAS uploads without git)'}`,
    'Build profiles (eas.json):',
    prof,
  ].join('\n');
}

// ---------------------------------------------------------------- eas.json

export const DEFAULT_EAS_JSON = {
  cli: { version: '>= 16.0.0', appVersionSource: 'remote' },
  build: {
    'ios-simulator': { ios: { simulator: true } },
    development: { developmentClient: true, distribution: 'internal' },
    preview: { distribution: 'internal' },
    production: { autoIncrement: true },
  },
  submit: { production: {} },
};

/** node script: adds eas.json if missing (or the ios-simulator profile to an existing one) and sets ios.bundleIdentifier in app.json */
function setupScript(bundleId: string | null): string {
  return `const fs=require('fs');const out=[];
let eas=null;try{eas=JSON.parse(fs.readFileSync('eas.json','utf8'))}catch(e){}
if(!eas){fs.writeFileSync('eas.json',JSON.stringify(${JSON.stringify(DEFAULT_EAS_JSON)},null,2)+'\\n');out.push('created eas.json');}
else{eas.build=eas.build||{};if(!Object.values(eas.build).some(p=>p&&p.ios&&p.ios.simulator===true)){eas.build['ios-simulator']={ios:{simulator:true}};fs.writeFileSync('eas.json',JSON.stringify(eas,null,2)+'\\n');out.push('added ios-simulator profile to eas.json');}}
const bid=${JSON.stringify(bundleId)};
if(bid){if(fs.existsSync('app.json')){const a=JSON.parse(fs.readFileSync('app.json','utf8'));const c=a.expo?a.expo:a;c.ios=c.ios||{};if(c.ios.bundleIdentifier!==bid){c.ios.bundleIdentifier=bid;fs.writeFileSync('app.json',JSON.stringify(a,null,2)+'\\n');out.push('set ios.bundleIdentifier '+bid);}}else{out.push('NO_APP_JSON');}}
console.log(${JSON.stringify(MARK)}+JSON.stringify(out));`;
}

const runEnv = (token: string, git: boolean): Record<string, string> => ({ EXPO_TOKEN: token, CI: '1', EXPO_NO_TELEMETRY: '1', EAS_BUILD_NO_EXPO_GO_WARNING: 'true', ...(git ? {} : { EAS_NO_VCS: '1' }) });

// ---------------------------------------------------------------- builds

export interface ExpoBuild {
  id: string;
  status: string;
  platform?: string;
  buildProfile?: string | null;
  distribution?: string | null;
  appVersion?: string | null;
  appBuildVersion?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  expirationDate?: string | null;
  queuePosition?: number | null;
  estimatedWaitTimeLeftSeconds?: number | null;
  error?: { errorCode?: string; message?: string; docsUrl?: string | null } | null;
  artifacts?: { buildUrl?: string | null; applicationArchiveUrl?: string | null } | null;
  logFiles?: string[];
  app?: { slug?: string; ownerAccount?: { name?: string } } | null;
}

const BUILD_FIELDS = 'id status platform buildProfile distribution appVersion appBuildVersion createdAt completedAt expirationDate queuePosition estimatedWaitTimeLeftSeconds error { errorCode message docsUrl } artifacts { buildUrl applicationArchiveUrl } logFiles app { id slug ownerAccount { id name } }';

export const buildPage = (b: ExpoBuild) => (b.app?.ownerAccount?.name && b.app.slug ? `https://expo.dev/accounts/${b.app.ownerAccount.name}/projects/${b.app.slug}/builds/${b.id}` : null);
const DONE = new Set(['FINISHED', 'ERRORED', 'CANCELED']);

export function describeBuild(b: ExpoBuild): string {
  const page = buildPage(b);
  const l = [`Build ${b.id}: ${b.status}${b.platform ? ` · ${b.platform}` : ''}${b.buildProfile ? ` · profile ${b.buildProfile}` : ''}${b.appVersion ? ` · version ${b.appVersion}${b.appBuildVersion ? ` (${b.appBuildVersion})` : ''}` : ''}`];
  if (b.status === 'IN_QUEUE' || b.status === 'NEW') l.push(`  Waiting in Expo's queue${b.queuePosition ? ` (position ${b.queuePosition})` : ''}${b.estimatedWaitTimeLeftSeconds ? `, about ${Math.ceil(b.estimatedWaitTimeLeftSeconds / 60)} min left` : ''}.`);
  if (b.status === 'FINISHED' && b.artifacts?.buildUrl) {
    const sim = /\.tar\.gz(\?|$)/.test(b.artifacts.buildUrl) || b.distribution === 'SIMULATOR';
    l.push(`  Download: ${b.artifacts.buildUrl}${sim ? ' (iOS Simulator app, .tar.gz — runs on a Mac simulator, not on an iPhone)' : ' (.ipa for iPhones)'}`);
    if (b.expirationDate) l.push(`  Expo keeps it until ${b.expirationDate.slice(0, 10)}.`);
  }
  if (b.error?.message) l.push(`  Error${b.error.errorCode ? ` ${b.error.errorCode}` : ''}: ${clip(b.error.message, 800)}${b.error.docsUrl ? ` (${b.error.docsUrl})` : ''}`);
  if (page) l.push(`  Build page${b.distribution === 'INTERNAL' ? ' (install on a registered iPhone from here)' : ''}: ${page}`);
  return l.join('\n');
}

/** Last lines of an errored build's logs (signed log URLs, no token needed). */
async function logTail(svc: AgentServices, urls: string[], signal: AbortSignal, owner: string): Promise<string> {
  const lines: string[] = [];
  for (const u of urls.slice(-2)) {
    try {
      const res = await svc.fetchImpl(u, { signal });
      if (!res.ok) continue;
      for (const raw of (await res.text()).split('\n')) {
        if (!raw.trim()) continue;
        try {
          const j = JSON.parse(raw) as { msg?: string; phase?: string };
          if (j.msg) lines.push(`${j.phase ? `[${j.phase}] ` : ''}${j.msg}`);
        } catch {
          lines.push(raw);
        }
      }
    } catch {
      /* a log we cannot read is skipped */
    }
  }
  const { redactSecrets } = await import('./sandbox/secrets.js');
  return redactSecrets(owner, lines.slice(-60).join('\n'));
}

/** The JSON array eas-cli prints with --json (the last top-level JSON array in stdout). */
export function parseBuildJson(stdout: string): ExpoBuild[] {
  const start = stdout.indexOf('[');
  for (let i = start; i >= 0; i = stdout.indexOf('[', i + 1)) {
    try {
      const v = JSON.parse(stdout.slice(i).trim()) as unknown;
      if (Array.isArray(v) && v.every((b) => b && typeof b === 'object' && 'id' in b)) return v as ExpoBuild[];
    } catch {
      /* not here */
    }
  }
  return [];
}

/** Plain-words reason for a failed eas-cli run. */
export function easFailure(out: string): string {
  if (/bearer token is invalid|AUTHENTICATION_ERROR|not logged in|log in to EAS/i.test(out)) return 'Expo refused the token. Connect Expo again on the Apps page with a new personal access token.';
  if (/Credentials are not set up|Run this command again in interactive mode|distribution certificate|provisioning profile/i.test(out)) return `Apple signing is not set up on Expo for this app, and it cannot be done non-interactively.\n${APPLE_SIGNING_HELP}`;
  if (/EAS project not configured|projectId|eas init/i.test(out) && /not configured|missing|must be linked/i.test(out)) return 'The project is not linked to your Expo account. Run expo_setup_ios first.';
  if (/bundle identifier|bundleIdentifier/i.test(out)) return 'The iOS bundle identifier is missing or invalid. Run expo_setup_ios with bundle_id.';
  if (/reached the limit|used up|quota|plan limit|out of builds|Free plan/i.test(out)) return 'Your Expo plan has no builds left for now (the Free plan resets monthly). Nothing was charged.';
  if (/ENOTFOUND|EAI_AGAIN|network/i.test(out)) return 'The computer could not reach Expo or npm (network).';
  return 'eas-cli failed; see the output.';
}

async function getBuild(svc: AgentServices, token: string, id: string, signal: AbortSignal): Promise<ExpoBuild> {
  const d = await expoGql<{ builds: { byId: ExpoBuild } }>(svc, token, `query OrinBuild($buildId: ID!) { builds { byId(buildId: $buildId) { ${BUILD_FIELDS} } } }`, { buildId: id }, signal);
  return d.builds.byId;
}

async function listBuilds(svc: AgentServices, token: string, appId: string, limit: number, signal: AbortSignal): Promise<ExpoBuild[]> {
  const d = await expoGql<{ app: { byId: { builds: ExpoBuild[] } } }>(
    svc,
    token,
    `query OrinBuilds($appId: String!, $offset: Int!, $limit: Int!, $filter: BuildFilter) { app { byId(appId: $appId) { id builds(offset: $offset, limit: $limit, filter: $filter) { ${BUILD_FIELDS} } } } }`,
    { appId, offset: 0, limit, filter: { platform: 'IOS' } },
    signal,
  );
  return d.app?.byId?.builds ?? [];
}

async function appInfo(svc: AgentServices, token: string, projectId: string, signal: AbortSignal): Promise<{ fullName: string; owner: string; slug: string }> {
  const d = await expoGql<{ app: { byId: { fullName: string; slug: string; ownerAccount: { name: string } } } }>(svc, token, 'query OrinApp($appId: String!) { app { byId(appId: $appId) { id fullName slug ownerAccount { id name } } } }', { appId: projectId }, signal);
  return { fullName: d.app.byId.fullName, owner: d.app.byId.ownerAccount.name, slug: d.app.byId.slug };
}

// ---------------------------------------------------------------- tools

const pathArg = z.string().min(1).max(300).describe('the Expo project folder on your computer, e.g. "myapp"');

export const expoCheckTool = defineTool({
  name: 'expo_check',
  description:
    'Check Expo for iOS builds: which Expo account the token belongs to and, given a project folder on your computer, whether it is ready for an EAS iOS cloud build (linked EAS project, bundle id, eas.json profiles, and whether Apple signing credentials are stored on Expo for each device profile). Read-only. Run it before expo_setup_ios or expo_build_ios and tell the user exactly what is missing.',
  schema: z.object({ path: pathArg.optional() }),
  label: () => 'Checking Expo…',
  needs: (p) => expoNeeds(p),
  timeoutMs: 4 * 60_000,
  handler: async (a, ctx) => {
    const token = tokenFor(ctx);
    const src = expoTokenOf(ctx)?.source;
    const me = await expoWhoAmI(ctx.services, token, ctx.signal);
    const lines = [`Expo token OK (${src === 'vault' ? 'from the Secure Vault' : 'from the Apps page'}): ${me.kind === 'Robot' ? 'robot user' : `user ${me.name}`}; accounts: ${me.accounts.join(', ') || 'none'}.`];
    if (!a.path) return { content: `${lines.join('\n')}\nGive a project folder to check whether it is ready for an iOS build.`, summary: `Expo: ${me.name}` };
    if (sandboxNeeds(ctx.services, ctx.owner)) return { content: `${lines.join('\n')}\nChecking a project needs your computer (sandbox), which is not set up.`, summary: 'No computer' };
    const p = await inspectProject(ctx, a.path);
    lines.push(describeProject(p));
    const blockers = blockersFor(p);
    if (p.projectId && p.bundleId) {
      try {
        const info = await appInfo(ctx.services, token, p.projectId, ctx.signal);
        lines.push(`EAS project: ${info.fullName}`);
        const device = p.profiles.filter((x) => !x.simulator && x.credentialsSource !== 'local');
        const seen = new Map<IosDistribution, SigningState>();
        for (const prof of device) {
          const dist = distributionOf(prof)!;
          if (!seen.has(dist)) seen.set(dist, await iosSigning(ctx.services, token, info.owner, info.fullName, p.bundleId, dist, ctx.signal));
          const s = seen.get(dist)!;
          lines.push(
            `Apple signing for "${prof.name}" (${dist}): ${s.ready ? `ready — certificate ${s.certificate!.serial} valid until ${s.certificate!.validUntil.slice(0, 10)}, profile ${s.profile!.status} until ${s.profile!.expires.slice(0, 10)}` : `NOT ready — ${!s.certificate ? 'no distribution certificate' : s.certificate.expired ? 'certificate expired' : ''}${!s.profile ? `${!s.certificate ? ', ' : ''}no provisioning profile` : s.profile.expired ? ', provisioning profile expired' : ''} stored on Expo`}`,
          );
        }
        for (const prof of p.profiles.filter((x) => !x.simulator && x.credentialsSource === 'local')) lines.push(`Apple signing for "${prof.name}": from credentials.json on the computer (${p.credentialsJson ? 'present' : 'MISSING'}).`);
        if (device.length && [...seen.values()].some((s) => !s.ready)) lines.push('', APPLE_SIGNING_HELP);
      } catch (e) {
        lines.push(`Could not read the EAS project or its iOS credentials: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const sim = p.profiles.find((x) => x.simulator);
    lines.push('', blockers.length ? `To fix before any iOS build:\n${blockers.map((b) => `- ${b}`).join('\n')}` : `Ready for an iOS build. ${sim ? `"${sim.name}" needs no Apple account.` : 'Add a simulator profile (expo_setup_ios) for a build that needs no Apple account.'}`);
    log(ctx, 'command', `Checked Expo setup of ${short(a.path, 40)}`, blockers.length === 0);
    return { content: lines.join('\n'), summary: blockers.length ? `${blockers.length} thing${blockers.length > 1 ? 's' : ''} to fix` : 'Ready for iOS builds' };
  },
});

export const expoSetupIosTool = defineTool({
  name: 'expo_setup_ios',
  description:
    'Prepare an Expo project on your computer for EAS iOS cloud builds: adds eas.json build profiles (ios-simulator, development, preview, production) if missing, sets the iOS bundle identifier in app.json, and links the project to an EAS project on the user\'s Expo account (eas init). Free, builds nothing, but it creates or links a project on their Expo account, so the user approves first. It does not set up Apple signing (that needs the user\'s Apple account; see expo_check).',
  schema: z.object({
    path: pathArg,
    bundle_id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/, 'reverse-domain, e.g. com.yourname.appname')
      .max(155)
      .optional()
      .describe('iOS bundle identifier to set when the project has none, e.g. com.fa.myapp'),
    account: z.string().max(60).optional().describe('Expo account that should own the project (default: the token\'s own account)'),
  }),
  label: () => 'Setting up Expo…',
  needs: (p) => expoAndSandboxNeeds(p),
  approval: (a) => ({
    title: 'Link project to your Expo account',
    headline: a.path,
    body: `Orin wants to create or link an EAS project for ${a.path} on your Expo account${a.account ? ` (${a.account})` : ''}, add eas.json build profiles${a.bundle_id ? ` and set the iOS bundle ID to ${a.bundle_id}` : ''}. Nothing is built or paid for.`,
    fields: [{ label: 'Project folder', value: a.path }, ...(a.bundle_id ? [{ label: 'iOS bundle ID', value: a.bundle_id }] : []), ...(a.account ? [{ label: 'Expo account', value: a.account }] : [])],
  }),
  timeoutMs: 8 * 60_000,
  handler: async (a, ctx) => {
    const token = tokenFor(ctx);
    const before = await inspectProject(ctx, a.path);
    if (!before.isExpo) return { ok: false, content: blockersFor(before)[0] ?? 'Not an Expo project.', summary: 'Not an Expo project' };
    if (!before.bundleId && !a.bundle_id) return { ok: false, content: 'The project has no iOS bundle identifier. Ask the user what it should be (reverse-domain, e.g. com.theirname.appname — it cannot be changed after the app is on the App Store), then call again with bundle_id.', summary: 'Needs a bundle id' };
    if (a.bundle_id && before.dynamicConfig && !before.bundleId) return { ok: false, content: `The config is ${before.dynamicConfig}, which Orin cannot rewrite safely. Add ios: { bundleIdentifier: "${a.bundle_id}" } to it with sandbox_edit_file, then call again.`, summary: 'Edit the config first' };
    const dir = before.dir;
    const steps: string[] = [];
    const s1 = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(`node -e ${shq(setupScript(before.bundleId ? null : (a.bundle_id ?? null)))}`, { cwd: dir, timeoutMs: 60_000 })));
    const done = s1.stdout.split('\n').find((l) => l.startsWith(MARK));
    if (!done) return { ok: false, content: `Could not write the build settings: ${clip(s1.stderr || s1.stdout, 600)}`, summary: 'Setup failed' };
    steps.push(...(JSON.parse(done.slice(MARK.length)) as string[]).filter((x) => x !== 'NO_APP_JSON'));
    if (!before.projectId) {
      const cmd = `${EAS} init --non-interactive --force ${a.account ? `--account ${shq(a.account)}` : ''} 2>&1 | tail -25`;
      const t0 = Date.now();
      const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: dir, timeoutMs: 7 * 60_000, envs: runEnv(token, before.git) })));
      const after = await inspectProject(ctx, a.path);
      log(ctx, 'command', after.projectId ? 'Linked the project to Expo (eas init)' : 'eas init did not link the project', Boolean(after.projectId), Date.now() - t0);
      if (!after.projectId) return { ok: false, content: `${steps.length ? `Done: ${steps.join('; ')}.\n` : ''}Linking with eas init failed (exit ${r.exitCode}): ${easFailure(r.stdout + r.stderr)}\n\n${clip(r.stdout + r.stderr, 2500)}`, summary: 'Not linked' };
      steps.push(`linked to EAS project ${after.projectId}${after.owner ? ` (owner ${after.owner})` : ''}`);
      return { content: `Done: ${steps.join('; ')}.\n\n${describeProject(after)}\n\nNext: expo_build_ios with the ios-simulator profile needs nothing else. Device profiles need Apple signing first (expo_check shows it).`, summary: 'Expo set up' };
    }
    const after = await inspectProject(ctx, a.path);
    log(ctx, 'command', 'Updated the Expo build settings');
    return { content: `${steps.length ? `Done: ${steps.join('; ')}.` : 'Already set up; nothing changed.'}\n\n${describeProject(after)}`, summary: steps.length ? 'Expo set up' : 'Already set up' };
  },
});

export const expoBuildIosTool = defineTool({
  name: 'expo_build_ios',
  description:
    'Start an iOS build of an Expo project on EAS (Expo\'s cloud, no Mac needed) with eas build --non-interactive, and return the build id and page. The ios-simulator profile needs only the Expo token; device profiles (preview, production) need Apple signing already stored on Expo and stop with what is missing otherwise. Uses one of the user\'s Expo plan builds, so the user approves first. Never submits to the App Store. Follow it with expo_build_status.',
  schema: z.object({
    path: pathArg,
    profile: z.string().min(1).max(60).optional().describe('eas.json build profile (default: the simulator profile if there is one, else "preview")'),
    message: z.string().max(200).optional().describe('short note shown on the build page'),
  }),
  label: (a) => `Starting iOS build${a.profile ? ` (${a.profile})` : ''}…`,
  needs: (p) => expoAndSandboxNeeds(p),
  approval: (a) => ({
    title: 'Start iOS build on Expo',
    headline: `${a.path}${a.profile ? ` · ${a.profile}` : ''}`,
    body: `Orin wants to upload ${a.path} to Expo and build it for iOS in Expo's cloud${a.profile ? ` with the "${a.profile}" profile` : ''}. It uses one of your Expo plan's iOS builds (the Free plan includes 15 a month and never charges extra; paid plans can bill extra usage). Nothing is submitted to the App Store.`,
    fields: [{ label: 'Project folder', value: a.path }, { label: 'Profile', value: a.profile ?? 'simulator profile, else preview' }, ...(a.message ? [{ label: 'Note', value: a.message }] : [])],
  }),
  timeoutMs: 12 * 60_000,
  handler: async (a, ctx) => {
    const token = tokenFor(ctx);
    const p = await inspectProject(ctx, a.path);
    const profileName = a.profile ?? p.profiles.find((x) => x.simulator)?.name ?? 'preview';
    const blockers = blockersFor(p, profileName);
    if (blockers.length) return { ok: false, content: `Not built — fix these first:\n${blockers.map((b) => `- ${b}`).join('\n')}`, summary: 'Not ready to build' };
    const prof = p.profiles.find((x) => x.name === profileName)!;
    if (!prof.simulator) {
      if (prof.credentialsSource === 'local') {
        if (!p.credentialsJson) return { ok: false, content: `Profile "${profileName}" signs with credentials.json, which is not in the project.\n${APPLE_SIGNING_HELP}`, summary: 'Apple signing missing' };
      } else {
        const info = await appInfo(ctx.services, token, p.projectId!, ctx.signal);
        const s = await iosSigning(ctx.services, token, info.owner, info.fullName, p.bundleId!, distributionOf(prof)!, ctx.signal);
        if (!s.ready) return { ok: false, content: `Not built — profile "${profileName}" makes an app for real iPhones, and Expo has no valid Apple signing for ${p.bundleId} (${s.distribution}).\n${APPLE_SIGNING_HELP}`, summary: 'Apple signing missing' };
      }
    }
    const cmd = `${EAS} build --platform ios --profile ${shq(profileName)} --non-interactive --no-wait --json ${a.message ? `--message ${shq(a.message)}` : ''} 2>/tmp/orin-eas-build.err; c=$?; echo; echo "--- log ---"; tail -40 /tmp/orin-eas-build.err; rm -f /tmp/orin-eas-build.err; exit $c`;
    const t0 = Date.now();
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: p.dir, timeoutMs: 11 * 60_000, envs: runEnv(token, p.git) })));
    const builds = parseBuildJson(r.stdout.split('--- log ---')[0] ?? '');
    log(ctx, 'command', builds.length ? `Started iOS build on Expo (${profileName})` : `iOS build on Expo did not start (${profileName})`, builds.length > 0, Date.now() - t0);
    if (!builds.length) return { ok: false, content: `The build did not start (exit ${r.exitCode}): ${easFailure(r.stdout + r.stderr)}\n\n${clip(r.stdout + r.stderr, 3000)}`, summary: 'Build not started' };
    const b = builds[0]!;
    const page = buildPage(b);
    return {
      content: `iOS build started on Expo (profile ${profileName}${prof.simulator ? ', simulator' : ''}).\n${describeBuild(b)}\n\nIt usually takes several minutes, longer in the Free plan's queue. Check it with expo_build_status (build_id ${b.id}, wait_minutes to follow it).`,
      summary: 'iOS build started',
      ...(page ? { display: { kind: 'page' as const, url: page, title: `iOS build · ${profileName}` } } : {}),
    };
  },
});

export const expoBuildStatusTool = defineTool({
  name: 'expo_build_status',
  description:
    'Status of EAS iOS builds: one build by id (optionally waiting up to wait_minutes for it to finish), or the recent iOS builds of a project folder. Gives the download link (.ipa for iPhones, .tar.gz for the simulator), the build page, and for a failed build the error and the last log lines. save_to_computer downloads a finished build into the project folder.',
  schema: z.object({
    build_id: z.string().max(80).optional(),
    path: pathArg.optional().describe('project folder, to list its recent iOS builds when no build_id is given'),
    wait_minutes: z.number().int().min(0).max(10).optional(),
    save_to_computer: z.boolean().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  label: () => 'Checking the iOS build…',
  needs: (p) => expoNeeds(p),
  timeoutMs: 12 * 60_000,
  handler: async (a, ctx) => {
    const token = tokenFor(ctx);
    if (!a.build_id) {
      if (!a.path) return { ok: false, content: 'Give build_id, or path to list the project\'s builds.', summary: 'Which build?' };
      const p = await inspectProject(ctx, a.path);
      if (!p.projectId) return { ok: false, content: 'This project is not linked to Expo yet, so it has no builds.', summary: 'Not linked' };
      const list = await listBuilds(ctx.services, token, p.projectId, a.limit ?? 5, ctx.signal);
      return { content: list.length ? list.map(describeBuild).join('\n\n') : 'No iOS builds yet for this project.', summary: `${list.length} iOS build${list.length === 1 ? '' : 's'}` };
    }
    let b = await getBuild(ctx.services, token, a.build_id, ctx.signal);
    const until = Date.now() + (a.wait_minutes ?? 0) * 60_000;
    while (!DONE.has(b.status) && Date.now() < until) {
      await sleep(Math.min(30_000, Math.max(1000, until - Date.now())), ctx.signal);
      b = await getBuild(ctx.services, token, a.build_id, ctx.signal);
    }
    let out = describeBuild(b);
    if (b.status === 'ERRORED' && b.logFiles?.length) {
      const tail = await logTail(ctx.services, b.logFiles, ctx.signal, ctx.owner);
      if (tail) out += `\n\nLast log lines:\n${tail}`;
    }
    if (a.save_to_computer && b.status === 'FINISHED' && b.artifacts?.buildUrl && !sandboxNeeds(ctx.services, ctx.owner)) {
      const ext = /\.tar\.gz(\?|$)/.test(b.artifacts.buildUrl) ? 'tar.gz' : /\.ipa(\?|$)/.test(b.artifacts.buildUrl) ? 'ipa' : 'bin';
      const dest = `${sandboxPath(a.path ?? 'builds')}/eas-builds/ios-${b.id.slice(0, 8)}.${ext}`;
      const r = await withSandbox(ctx, (s) => s.exec(`mkdir -p ${shq(dest.replace(/\/[^/]+$/, ''))} && curl -fsSL -o ${shq(dest)} ${shq(b.artifacts!.buildUrl!)} && ls -l ${shq(dest)}`, { timeoutMs: 8 * 60_000 }));
      out += r.exitCode === 0 ? `\n\nSaved on your computer: ${dest}` : `\n\nCould not download it to the computer (exit ${r.exitCode}).`;
      if (r.exitCode === 0) log(ctx, 'save', `Downloaded iOS build to ${dest}`);
    }
    const page = buildPage(b);
    return { content: out, summary: b.status === 'FINISHED' ? 'iOS build ready' : b.status === 'ERRORED' ? 'iOS build failed' : `iOS build ${b.status.toLowerCase().replace(/_/g, ' ')}`, ...(page ? { display: { kind: 'page' as const, url: page, title: `iOS build · ${b.status.toLowerCase()}` } } : {}) };
  },
});

export const expoTools: ToolDef[] = [expoCheckTool, expoSetupIosTool, expoBuildIosTool, expoBuildStatusTool];
