# api-mpox.js

const CKAN_ACTION = "https://opendatasus.saude.gov.br/api/3/action";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // cache (CDN da Vercel)
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
}

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "mpox-dashboard/1.0", accept: "application/json" },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Resposta não-JSON do upstream. Status ${r.status}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return json;
}

function pickBestDataset(results) {
  const scored = results.map((d) => {
    const name = String(d.name || "").toLowerCase();
    const title = String(d.title || "").toLowerCase();
    let s = 0;
    if (name.includes("mpox") || title.includes("mpox")) s += 5;
    if (name.includes("sinan") || title.includes("sinan")) s += 3;
    if (title.includes("e-sus")) s += 2;
    if (Array.isArray(d.resources) && d.resources.length) s += 1;
    return { d, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.d || null;
}

function detectField(fields, candidates) {
  const lower = fields.map((f) => String(f.id || "").toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return fields[idx].id;
  }
  for (const c of candidates) {
    const idx = lower.findIndex((x) => x.includes(c.toLowerCase()));
    if (idx >= 0) return fields[idx].id;
  }
  return null;
}

function normalizeUF(x) {
  const s = String(x || "").trim().toUpperCase();
  return s.length === 2 ? s : null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(200).end();
  }

  try {
    setCors(res);

    const days = Math.max(7, Math.min(365, Number(req.query.days || 60)));

    // ✅ Você pode fixar dataset/resource via ENV (recomendado quando escolher o dataset final)
    // DATASET_ID = "nome-do-dataset"
    // RESOURCE_ID = "uuid-do-resource"
    const DATASET_ID = process.env.DATASET_ID || null;
    const RESOURCE_ID = process.env.RESOURCE_ID || null;

    let datasetName = DATASET_ID;
    let resourceId = RESOURCE_ID;
    let datasetTitle = "";
    let resourceName = "";

    // 1) Descobre dataset/resource automaticamente (se não fixou ENV)
    if (!datasetName || !resourceId) {
      const ps = await fetchJSON(`${CKAN_ACTION}/package_search?q=${encodeURIComponent("mpox")}&rows=10`);
      if (!ps.success) throw new Error("CKAN package_search falhou.");

      const best = pickBestDataset(ps.result?.results || []);
      if (!best) throw new Error("Não encontrei dataset de MPOX no CKAN.");

      const show = await fetchJSON(`${CKAN_ACTION}/package_show?id=${encodeURIComponent(best.name)}`);
      if (!show.success) throw new Error("CKAN package_show falhou.");

      const ds = show.result;
      datasetName = ds.name;
      datasetTitle = ds.title || "";
      const resources = ds.resources || [];
      const r =
        resources.find((x) => x.datastore_active) ||
        resources.find((x) => String(x.format || "").toUpperCase() === "CSV") ||
        resources[0];

      if (!r?.id) throw new Error("Dataset sem resource_id.");
      resourceId = r.id;
      resourceName = r.name || r.description || "";
    }

    // 2) Precisa ser DataStore pra query SQL (senão, fica pesado pro serverless)
    const meta = await fetchJSON(`${CKAN_ACTION}/datastore_search?resource_id=${encodeURIComponent(resourceId)}&limit=0`);
    if (!meta.success) {
      throw new Error("Resource não tem DataStore ativo (não dá pra fazer SQL leve).");
    }

    const fields = meta.result?.fields || [];
    if (!fields.length) throw new Error("DataStore sem fields.");

    const ufField = detectField(fields, [
      "sg_uf", "uf", "uf_notificacao", "uf_notif", "sigla_uf",
      "uf_residencia", "uf_res", "sg_uf_residencia", "sg_uf_notificacao"
    ]);
    const dateField = detectField(fields, [
      "data_notificacao", "dt_notificacao", "data_notif", "dt_notif",
      "data_sintomas", "dt_sintomas", "data_inicio_sintomas", "data", "dt"
    ]);
    const statusField = detectField(fields, [
      "classificacao_final", "classificacao", "resultado", "status", "criterio_confirmacao"
    ]);

    if (!ufField || !dateField) {
      throw new Error(`Não detectei campos necessários (UF/Data). UF=${ufField} Data=${dateField}`);
    }

    // 3) WHERE opcional (se tiver um campo “status”, tenta filtrar confirmados)
    let where = "";
    let note = "Sem filtro de confirmação.";
    if (statusField) {
      where = `WHERE lower("${statusField}") LIKE '%confirm%'`;
      note = `Filtrando “confirmados” (contains 'confirm') em "${statusField}".`;
    }

    // 4) Agregado por UF
    const sqlUF = `
      SELECT "${ufField}" AS uf, count(*)::int AS cases
      FROM "${resourceId}"
      ${where}
      GROUP BY 1
    `.trim();

    const ufRes = await fetchJSON(`${CKAN_ACTION}/datastore_search_sql?sql=${encodeURIComponent(sqlUF)}`);
    if (!ufRes.success) throw new Error("SQL UF falhou.");

    const ufMap = new Map();
    for (const r of ufRes.result?.records || []) {
      const uf = normalizeUF(r.uf);
      if (!uf) continue;
      ufMap.set(uf, Number(r.cases || 0));
    }

    // 5) Série diária (últimos N dias)
    const sqlSeries = `
      SELECT date_trunc('day', "${dateField}"::timestamp)::date AS date, count(*)::int AS cases
      FROM "${resourceId}"
      ${where ? where + " AND" : "WHERE"}
      "${dateField}"::timestamp >= now() - interval '${days} days'
      GROUP BY 1
      ORDER BY 1
    `.trim();

    const sRes = await fetchJSON(`${CKAN_ACTION}/datastore_search_sql?sql=${encodeURIComponent(sqlSeries)}`);
    if (!sRes.success) throw new Error("SQL série falhou.");

    const raw = (sRes.result?.records || []).map((r) => ({
      date: String(r.date),
      cases: Number(r.cases || 0),
    }));

    // rolling 7d
    const series = raw.map((p, idx) => {
      const from = Math.max(0, idx - 6);
      const sum7 = raw.slice(from, idx + 1).reduce((a, x) => a + x.cases, 0);
      return { ...p, cases7d: sum7 };
    });

    return res.status(200).json({
      meta: {
        datasetName,
        datasetTitle,
        resourceId,
        resourceName,
        ufField,
        dateField,
        statusField: statusField || "",
        note,
        days,
      },
      byUF: Object.fromEntries(ufMap),
      series,
    });
  } catch (e) {
    setCors(res);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
