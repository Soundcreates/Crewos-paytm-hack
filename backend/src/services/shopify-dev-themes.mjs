import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const execFile = promisify(nodeExecFile);
const categories = { footwear: ['Footwear', '#cc6b3d'], clothing: ['Clothing', '#6d62a6'], bags: ['Bags and carry', '#a46a3e'], technology: ['Technology', '#42659a'], belts: ['Leather goods', '#875537'] };
const error = (status, code, message) => Object.assign(new Error(message), { status, code });

export function buildDevelopmentTheme({ name, category }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !Object.hasOwn(categories, category)) throw error(400, 'dev_theme_input_invalid', 'A store name and supported category are required.');
  const [label, accent] = categories[category];
  const sections = { main: { type: 'crewos-home', settings: { heading: name.trim(), subtitle: `Discover ${label.toLowerCase()} made for everyday life.` } } };
  return {
    'layout/theme.liquid': `<!doctype html><html lang="{{ request.locale.iso_code }}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{ page_title | escape }}</title>{{ content_for_header }}{{ 'crewos.css' | asset_url | stylesheet_tag }}</head><body><header class="top"><a href="{{ routes.root_url }}">{{ shop.name | escape }}</a><a href="{{ routes.cart_url }}">Cart ({{ cart.item_count }})</a></header><main id="MainContent">{{ content_for_layout }}</main><footer>{{ shop.name | escape }}</footer></body></html>`,
    'templates/index.json': JSON.stringify({ sections, order: ['main'] }),
    'sections/crewos-home.liquid': `<section class="hero"><p class="eyebrow">{{ shop.name | escape }}</p><h1>{{ section.settings.heading | escape }}</h1><p>{{ section.settings.subtitle | escape }}</p><a class="button" href="{{ routes.all_products_collection_url }}">Explore the collection</a></section><section class="collection"><p class="eyebrow">The collection</p><h2>Made to be used. Made to last.</h2><div class="grid">{% for product in collections.all.products limit: 8 %}<a class="product" href="{{ product.url }}">{% if product.featured_image %}{{ product.featured_image | image_url: width: 720 | image_tag: loading: 'lazy' }}{% endif %}<strong>{{ product.title | escape }}</strong><span>{{ product.price | money }}</span></a>{% else %}<p>Products are being prepared. Check back soon.</p>{% endfor %}</div></section>{% schema %}{"name":"CrewOS home","settings":[{"type":"text","id":"heading","label":"Heading","default":"Welcome"},{"type":"text","id":"subtitle","label":"Subtitle","default":"Discover the collection."}]}{% endschema %}`,
    'templates/product.liquid': `<section class="collection"><h1>{{ product.title | escape }}</h1>{% if product.featured_image %}{{ product.featured_image | image_url: width: 900 | image_tag }}{% endif %}<p>{{ product.price | money }}</p><div>{{ product.description }}</div>{% form 'product', product %}<select name="id">{% for variant in product.variants %}<option value="{{ variant.id }}">{{ variant.title | escape }} — {{ variant.price | money }}</option>{% endfor %}</select><button class="button" type="submit">Add to cart</button>{% endform %}</section>`,
    'templates/cart.liquid': `<section class="collection"><h1>Your cart</h1>{% for item in cart.items %}<p><a href="{{ item.url }}">{{ item.product.title | escape }}</a> · {{ item.quantity }} · {{ item.final_line_price | money }}</p>{% else %}<p>Your cart is empty.</p>{% endfor %}<p>{{ cart.total_price | money }}</p>{% if cart.item_count > 0 %}<form action="{{ routes.cart_url }}" method="post"><button class="button" name="checkout" type="submit">Checkout</button></form>{% endif %}</section>`,
    'templates/collection.liquid': `<section class="collection"><h1>{{ collection.title | escape }}</h1><div class="grid">{% for product in collection.products %}<a class="product" href="{{ product.url }}"><strong>{{ product.title | escape }}</strong><span>{{ product.price | money }}</span></a>{% else %}<p>Products are being prepared.</p>{% endfor %}</div></section>`,
    'config/settings_schema.json': JSON.stringify([{ name: 'theme_info', theme_name: 'CrewOS', theme_version: '1.0.0', theme_author: 'CrewOS', theme_documentation_url: 'https://shopify.dev/docs/storefronts/themes', theme_support_url: 'https://shopify.dev/docs/storefronts/themes' }]),
    'config/settings_data.json': JSON.stringify({ current: {} }),
    'locales/en.default.json': '{}',
    'assets/crewos.css': `:root{--accent:${accent};--ink:#1d1c21;--cream:#f7f3ed}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font-family:Arial,sans-serif}.top{display:flex;justify-content:space-between;padding:24px 7%;border-bottom:1px solid #ddd}.top a,.product{color:inherit;text-decoration:none}.top a:first-child{font-weight:700;letter-spacing:.08em}.hero{padding:11vw 7%;background:linear-gradient(125deg,#f4e7dd,#e5e4f2);min-height:480px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:.7rem}.hero h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(3rem,8vw,7rem);line-height:1;max-width:900px;margin:24px 0}.hero p{font-size:1.1rem}.button{display:inline-block;background:var(--accent);color:white;text-decoration:none;border:0;padding:15px 24px;border-radius:50px;margin-top:22px}.collection{padding:70px 7%}.collection h2{font-family:Georgia,serif;font-weight:400;font-size:2.5rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:25px}.product{display:grid;gap:10px}.product img{width:100%;height:auto;background:#eee}footer{border-top:1px solid #ddd;padding:35px 7%}select{padding:12px}`,
  };
}

export function createShopifyDevThemeService({ get, run, newId, timestamp, env = process.env, execute = execFile }) {
  const find = (orgId, sessionId) => get('SELECT * FROM shopify_dev_theme_requests WHERE org_id=? AND voice_session_id=?', orgId, sessionId);
  const view = row => row ? { status: row.status, previewUrl: row.preview_url || null, themeId: row.theme_id || null, category: row.category, errorCode: row.error_code || null } : null;
  async function read(orgId, sessionId) {
    const row = await find(orgId, sessionId);
    if (row?.status === 'creating' && Date.now() - Date.parse(row.updated_at) > 180_000) {
      await run("UPDATE shopify_dev_theme_requests SET status='uncertain',error_code='theme_outcome_unknown',updated_at=? WHERE org_id=? AND id=? AND status='creating' AND updated_at=?", timestamp(), orgId, row.id, row.updated_at);
      return view(await find(orgId, sessionId));
    }
    return view(row);
  }
  async function create({ orgId, userId, voiceSessionId, category }) {
    if (!['1', 'true', 'yes', 'on'].includes(String(env.SHOPIFY_DEV_STORE_ENABLED || '').toLowerCase())) throw error(503, 'dev_store_disabled', 'Development store creation is not enabled.');
    if (!Object.hasOwn(categories, category)) throw error(400, 'dev_theme_input_invalid', 'Choose a supported store category.');
    const store = await get('SELECT id,org_id,voice_session_id,manager_user_id,store_name,status,store_domain FROM shopify_dev_store_requests WHERE org_id=? AND voice_session_id=?', orgId, voiceSessionId);
    if (!store || store.manager_user_id !== userId || store.status !== 'ready' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(store.store_domain || '')) throw error(409, 'dev_store_not_ready', 'A development store created for this interview is required.');
    const existing = await find(orgId, voiceSessionId);
    if (existing) {
      if (existing.category !== category || existing.manager_user_id !== userId) throw error(409, 'dev_theme_request_conflict', 'This store already has a different theme request.');
      return read(orgId, voiceSessionId);
    }
    const files = buildDevelopmentTheme({ name: store.store_name, category });
    const id = newId('shopify_dev_theme'), at = timestamp();
    const result = await run("INSERT INTO shopify_dev_theme_requests(id,org_id,store_request_id,voice_session_id,manager_user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'creating',?,?) ON CONFLICT(org_id,store_request_id) DO NOTHING", id, orgId, store.id, voiceSessionId, userId, category, at, at);
    if (result?.changes !== 1) { const prior = await find(orgId, voiceSessionId); if (!prior || prior.category !== category || prior.manager_user_id !== userId) throw error(409, 'dev_theme_request_conflict', 'This store already has a different theme request.'); return read(orgId, voiceSessionId); }
    const childEnv = { CI: '1', SHOPIFY_CLI_NO_ANALYTICS: '1' };
    for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'XDG_CONFIG_HOME']) if (env[key]) childEnv[key] = env[key];
    void (async () => {
      let directory;
      try {
        directory = await mkdtemp(join(tmpdir(), 'crewos-theme-'));
        for (const [path, content] of Object.entries(files)) { const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, 'utf8'); }
        const pushed = await execute('shopify', ['theme', 'push', '--unpublished', '--theme', `CrewOS ${store.store_name}`, '--store', store.store_domain, '--path', directory, '--nodelete', '--json'], { env: childEnv, timeout: 120_000, maxBuffer: 1_000_000 });
        const result = JSON.parse(pushed.stdout), theme = result?.theme, themeId = String(theme?.id || '');
        const preview = new URL(String(theme?.preview_url || ''));
        if (!/^\d+$/.test(themeId) || String(theme?.role || '').toLowerCase() !== 'unpublished' || String(theme?.shop || '').toLowerCase() !== store.store_domain || preview.protocol !== 'https:' || preview.hostname !== store.store_domain || preview.username || preview.password || preview.port || preview.hash || preview.searchParams.get('preview_theme_id') !== themeId) throw new Error('unverified_theme_result');
        await run("UPDATE shopify_dev_theme_requests SET status='ready',theme_id=?,preview_url=?,updated_at=? WHERE org_id=? AND id=? AND status='creating'", themeId, preview.toString(), timestamp(), orgId, id);
      } catch {
        await run("UPDATE shopify_dev_theme_requests SET status='uncertain',error_code='theme_outcome_unknown',updated_at=? WHERE org_id=? AND id=? AND status='creating'", timestamp(), orgId, id).catch(() => {});
      } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
    })();
    return read(orgId, voiceSessionId);
  }
  return { create, read };
}
