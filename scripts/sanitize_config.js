import fs from 'node:fs';

const configPath = 'dist/server/wrangler.json';
if (fs.existsSync(configPath)) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // Deduplicate D1 database bindings
  if (Array.isArray(cfg.d1_databases)) {
    const seen = new Set();
    cfg.d1_databases = cfg.d1_databases.filter((item) => {
      if (!item.binding || seen.has(item.binding)) return false;
      seen.add(item.binding);
      return true;
    });
  }

  // Deduplicate compatibility flags
  if (Array.isArray(cfg.compatibility_flags)) {
    cfg.compatibility_flags = [...new Set(cfg.compatibility_flags)];
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log('Sanitized dist/server/wrangler.json successfully.');
}
