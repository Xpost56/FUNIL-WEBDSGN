const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const PLACES_KEY = "AIzaSyCTaGnreZxO9RDAzVIbuS3L89XYnosFJ5U";
const GEO_KEY = "AIzaSyAapI_FKHelv6B0Y4__bdiOCdxseLye4NU";

function calcularScore(e) {
  let s = 0;
  if (!e.website) s += 40;
  if (e.avaliacoes > 100) s += 25;
  else if (e.avaliacoes > 50) s += 20;
  else if (e.avaliacoes > 20) s += 10;
  else if (e.avaliacoes > 5) s += 5;
  if (e.nota >= 4.5) s += 20;
  else if (e.nota >= 4.0) s += 15;
  else if (e.nota >= 3.5) s += 10;
  if (e.telefone) s += 15;
  return s;
}

async function getCoordenadas(lugar) {
  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: lugar + " Brasil", key: GEO_KEY }
    });
    if (r.data.results && r.data.results.length > 0) return r.data.results[0].geometry.location;
  } catch(e) {}
  return null;
}

async function buscarPaginas(query, locationBias, maxPaginas) {
  const todos = [];
  let nextPageToken = null;
  let pagina = 0;
  do {
    const body = { textQuery: query, maxResultCount: 20, languageCode: "pt-BR" };
    if (locationBias && !nextPageToken) body.locationBias = locationBias;
    if (nextPageToken) body.pageToken = nextPageToken;
    try {
      const resp = await axios.post(
        "https://places.googleapis.com/v1/places:searchText",
        body,
        {
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": PLACES_KEY,
            "X-Goog-FieldMask": "places.id,places.displayName,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.formattedAddress,nextPageToken"
          }
        }
      );
      todos.push(...(resp.data.places || []));
      nextPageToken = resp.data.nextPageToken || null;
      pagina++;
      if (nextPageToken) await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.log("Erro pagina", pagina, e.response ? JSON.stringify(e.response.data) : e.message);
      break;
    }
  } while (nextPageToken && pagina < maxPaginas);
  return todos;
}

// Gera variações de queries pra cobrir mais resultados
function gerarQueries(nicho, cidade) {
  if (cidade) {
    return [
      `${nicho} ${cidade}`,
      `${nicho} em ${cidade}`,
      `${nicho} ${cidade} centro`,
      `${nicho} ${cidade} zona norte`,
      `${nicho} ${cidade} zona sul`,
      `${nicho} ${cidade} zona leste`,
      `${nicho} ${cidade} zona oeste`,
      `${nicho} ${cidade} jardim`,
      `${nicho} ${cidade} vila`,
      `${nicho} ${cidade} parque`,
      `${nicho} proximo ${cidade}`,
      `${nicho} regiao ${cidade}`,
      `salao ${nicho} ${cidade}`,
      `studio ${nicho} ${cidade}`,
      `clinica ${nicho} ${cidade}`,
    ];
  }
  // Sem cidade — cobre as maiores cidades do Brasil
  const cidades = ["Sao Paulo", "Rio de Janeiro", "Curitiba", "Belo Horizonte", "Porto Alegre", "Salvador", "Fortaleza", "Recife", "Manaus", "Brasilia", "Goiania", "Belem", "Florianopolis", "Campinas", "Natal"];
  return cidades.map(c => `${nicho} ${c}`);
}

app.get("/buscar", async (req, res) => {
  const { nicho, cidade } = req.query;
  if (!nicho) return res.status(400).json({ erro: "Nicho obrigatorio" });
  try {
    const coords = cidade ? await getCoordenadas(cidade) : null;
    const locationBias = coords ? {
      circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: 50000.0 }
    } : null;

    const queries = gerarQueries(nicho, cidade);
    const todosMapa = new Map();

    for (const q of queries) {
      console.log("Query:", q);
      const places = await buscarPaginas(q, locationBias, 10);
      for (const p of places) {
        if (!todosMapa.has(p.id)) todosMapa.set(p.id, p);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const resultados = [];
    for (const place of todosMapa.values()) {
      if (!place.websiteUri) {
        const emp = {
          id: place.id,
          nome: place.displayName ? place.displayName.text : "Sem nome",
          telefone: place.internationalPhoneNumber || "",
          nota: place.rating || 0,
          avaliacoes: place.userRatingCount || 0,
          endereco: place.formattedAddress || ""
        };
        emp.score = calcularScore(emp);
        resultados.push(emp);
      }
    }

    resultados.sort((a, b) => b.score - a.score);
    console.log(`Total: ${resultados.length} sem site de ${todosMapa.size} encontrados`);
    res.json({ resultados, total_buscados: todosMapa.size });
  } catch(e) {
    console.log("Erro:", e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.post("/mensagem", async (req, res) => {
  const { empresa } = req.body;
  try {
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 300,
      messages: [{ role: "user", content: "Gere uma mensagem curta de WhatsApp para prospectar a empresa " + empresa.nome + " que nao tem site. Maximo 4 linhas, portugues brasileiro, informal mas profissional, CTA para conversar. Retorne APENAS a mensagem." }]
    }, { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" } });
    res.json({ mensagem: response.data.content[0].text });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getHTML());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Lead Miner porta " + PORT));

function getHTML() {
  return [
'<!DOCTYPE html>',
'<html lang="pt-BR">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>Lead Miner</title>',
'<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@800&display=swap" rel="stylesheet">',
'<style>',
':root{--bg:#0a0a0f;--surface:#111118;--surface2:#1a1a26;--border:#2a2a3a;--accent:#00ff88;--accent2:#7c3aed;--warn:#ff6b35;--text:#e8e8f0;--muted:#6b6b8a}',
'*{margin:0;padding:0;box-sizing:border-box}',
'body{background:var(--bg);color:var(--text);font-family:"Syne",sans-serif;min-height:100vh}',
'body::before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,136,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}',
'.wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:40px 24px}',
'header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:48px}',
'.logo-tag{font-family:"Space Mono",monospace;font-size:10px;color:var(--accent);letter-spacing:3px;text-transform:uppercase;display:block;margin-bottom:4px}',
'h1{font-size:36px;font-weight:800;letter-spacing:-1px}',
'h1 span{color:var(--accent)}',
'.badge{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:6px 12px;font-family:"Space Mono",monospace;font-size:11px;color:var(--muted)}',
'.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;margin-bottom:32px;position:relative;overflow:hidden}',
'.card::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--accent2))}',
'.lbl{font-family:"Space Mono",monospace;font-size:10px;color:var(--accent);letter-spacing:2px;text-transform:uppercase;margin-bottom:20px}',
'.row{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}',
'.fld{display:flex;flex-direction:column;gap:8px}',
'.fld label{font-size:11px;color:var(--muted);font-family:"Space Mono",monospace;letter-spacing:1px;text-transform:uppercase}',
'.hint{font-family:"Space Mono",monospace;font-size:10px;color:var(--muted);margin-top:4px;opacity:.6}',
'input[type=text]{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px;color:var(--text);font-family:"Space Mono",monospace;font-size:14px;outline:none;width:100%}',
'input[type=text]:focus{border-color:var(--accent)}',
'input::placeholder{color:var(--muted)}',
'.btn-ok{background:var(--accent);color:#000;border:none;border-radius:8px;padding:0 28px;font-family:"Syne",sans-serif;font-size:14px;font-weight:700;cursor:pointer;height:46px;white-space:nowrap}',
'.btn-ok:hover{background:#00cc6e}',
'.btn-ok:disabled{opacity:.5;cursor:not-allowed}',
'.toolbar{display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap}',
'.snum{font-family:"Space Mono",monospace;font-size:20px;font-weight:700;color:var(--accent)}',
'.slbl{font-size:12px;color:var(--muted)}',
'.sep{color:var(--border);font-size:18px}',
'.filter-btns{display:flex;gap:6px;margin-left:8px}',
'.fbtn{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:20px;padding:4px 14px;font-family:"Space Mono",monospace;font-size:11px;cursor:pointer;transition:all .2s}',
'.fbtn:hover{border-color:var(--accent);color:var(--accent)}',
'.fbtn.active{background:var(--accent);color:#000;border-color:var(--accent)}',
'.fbtn.f-contatado.active{background:#3b82f6;border-color:#3b82f6;color:#fff}',
'.fbtn.f-respondeu.active{background:var(--accent2);border-color:var(--accent2);color:#fff}',
'.fbtn.f-fechado.active{background:var(--warn);border-color:var(--warn);color:#fff}',
'.btn-csv{margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 16px;font-family:"Space Mono",monospace;font-size:11px;cursor:pointer;letter-spacing:1px;text-transform:uppercase}',
'.btn-csv:hover{border-color:var(--accent);color:var(--accent)}',
'.twrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}',
'table{width:100%;border-collapse:collapse}',
'thead tr{background:var(--surface2);border-bottom:1px solid var(--border)}',
'th{padding:12px 14px;text-align:left;font-family:"Space Mono",monospace;font-size:10px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;font-weight:400}',
'tbody tr{border-bottom:1px solid rgba(42,42,58,.4);transition:background .15s}',
'tbody tr:hover{background:rgba(0,255,136,.03)}',
'tbody tr.status-contatado{border-left:3px solid #3b82f6}',
'tbody tr.status-respondeu{border-left:3px solid var(--accent2)}',
'tbody tr.status-fechado{border-left:3px solid var(--warn);opacity:.5}',
'td{padding:12px 14px;font-size:13px;vertical-align:middle}',
'.tnome{font-weight:600;font-size:13px}',
'.tend{font-size:10px;color:var(--muted);margin-top:2px;font-family:"Space Mono",monospace}',
'.ttel{font-family:"Space Mono",monospace;font-size:11px;color:var(--accent)}',
'.ttel a{color:inherit;text-decoration:none}',
'.pill{display:inline-flex;padding:3px 10px;border-radius:20px;font-family:"Space Mono",monospace;font-size:11px;font-weight:700}',
'.hot{background:rgba(255,107,53,.15);color:var(--warn);border:1px solid rgba(255,107,53,.3)}',
'.bom{background:rgba(0,255,136,.1);color:var(--accent);border:1px solid rgba(0,255,136,.2)}',
'.med{background:rgba(124,58,237,.1);color:#a78bfa;border:1px solid rgba(124,58,237,.2)}',
'.baixo{background:rgba(107,107,138,.1);color:var(--muted);border:1px solid var(--border)}',
'.status-sel{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-family:"Space Mono",monospace;font-size:10px;cursor:pointer;outline:none;width:100%}',
'.status-sel option{background:var(--surface2)}',
'.btn-msg{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:10px;cursor:pointer;font-family:"Space Mono",monospace;white-space:nowrap}',
'.btn-msg:hover{border-color:var(--accent2);color:#a78bfa}',
'.spin-wrap{text-align:center;padding:80px 40px;display:none}',
'.spin{width:36px;height:36px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;margin:0 auto 16px}',
'@keyframes sp{to{transform:rotate(360deg)}}',
'.spin-wrap p{font-family:"Space Mono",monospace;font-size:12px;letter-spacing:2px;color:var(--muted);margin-bottom:8px}',
'.spin-wrap small{font-family:"Space Mono",monospace;font-size:10px;color:var(--muted);opacity:.5}',
'.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center;backdrop-filter:blur(4px)}',
'.overlay.open{display:flex}',
'.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:90%;max-width:520px;position:relative}',
'.modal::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent2),var(--accent));border-radius:12px 12px 0 0}',
'.mtitle{font-size:16px;font-weight:700;margin-bottom:6px}',
'.memp{font-family:"Space Mono",monospace;font-size:11px;color:var(--accent);margin-bottom:20px;letter-spacing:1px}',
'textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;color:var(--text);font-family:"Space Mono",monospace;font-size:13px;line-height:1.6;resize:vertical;min-height:140px;outline:none}',
'.mact{display:flex;gap:10px;margin-top:16px;justify-content:flex-end}',
'.btn-wpp{background:#25d366;color:#000;border:none;border-radius:6px;padding:10px 20px;font-family:"Syne",sans-serif;font-weight:700;font-size:13px;cursor:pointer}',
'.btn-wpp:hover{background:#1db954}',
'.btn-fch{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:10px 16px;font-family:"Space Mono",monospace;font-size:12px;cursor:pointer}',
'.toast{position:fixed;bottom:32px;right:32px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px 20px;font-family:"Space Mono",monospace;font-size:12px;z-index:200;transform:translateY(20px);opacity:0;transition:all .3s}',
'.toast.show{transform:translateY(0);opacity:1}',
'.toast.ok{border-color:var(--accent);color:var(--accent)}',
'.toast.err{border-color:var(--warn);color:var(--warn)}',
'</style>',
'</head>',
'<body>',
'<div class="wrap">',
'  <header>',
'    <div>',
'      <span class="logo-tag">// ferramenta interna</span>',
'      <h1>Lead <span>Miner</span></h1>',
'    </div>',
'    <div class="badge">v4.0 &middot; 200+ leads</div>',
'  </header>',
'  <div class="card">',
'    <div class="lbl">// nova busca</div>',
'    <div class="row">',
'      <div class="fld">',
'        <label>Nicho</label>',
'        <input type="text" id="nicho" placeholder="Barbearia, Clinica, Restaurante...">',
'      </div>',
'      <div class="fld">',
'        <label>Cidade (opcional)</label>',
'        <input type="text" id="cidade" placeholder="Deixe vazio para buscar no Brasil todo">',
'        <span class="hint">vazio = busca automatica nas maiores cidades</span>',
'      </div>',
'      <button class="btn-ok" id="btnB" onclick="buscar()">Buscar</button>',
'    </div>',
'  </div>',
'  <div class="spin-wrap" id="loading">',
'    <div class="spin"></div>',
'    <p>MINERANDO LEADS...</p>',
'    <small id="spinMsg">buscando multiplas paginas e regioes &mdash; aguarde ate 2 minutos</small>',
'  </div>',
'  <div id="res" style="display:none">',
'    <div class="toolbar">',
'      <div><span class="snum" id="totalVis">0</span> <span class="slbl">exibindo</span></div>',
'      <span class="sep">·</span>',
'      <div><span class="snum" id="totalAll">0</span> <span class="slbl">total sem site</span></div>',
'      <span class="sep">·</span>',
'      <div><span class="snum" style="color:var(--warn)" id="hot">0</span> <span class="slbl">quentes</span></div>',
'      <div class="filter-btns">',
'        <button class="fbtn active" onclick="filtrar(this,\'todos\')">Todos</button>',
'        <button class="fbtn" onclick="filtrar(this,\'pendente\')">Pendentes</button>',
'        <button class="fbtn f-contatado" onclick="filtrar(this,\'contatado\')">Contatados</button>',
'        <button class="fbtn f-respondeu" onclick="filtrar(this,\'respondeu\')">Responderam</button>',
'        <button class="fbtn f-fechado" onclick="filtrar(this,\'fechado\')">Fechados</button>',
'      </div>',
'      <button class="btn-csv" onclick="exportCSV()">EXPORTAR CSV</button>',
'    </div>',
'    <div class="twrap">',
'      <div id="empty" style="display:none;text-align:center;padding:60px;color:var(--muted)">Nenhuma empresa encontrada para esse filtro.</div>',
'      <table id="tb" style="display:none">',
'        <thead><tr><th>Score</th><th>Empresa</th><th>Aval.</th><th>Nota</th><th>Telefone</th><th>Status</th><th>Acao</th></tr></thead>',
'        <tbody id="tbody"></tbody>',
'      </table>',
'    </div>',
'  </div>',
'</div>',
'<div class="overlay" id="ov">',
'  <div class="modal">',
'    <div class="mtitle">Mensagem de Prospeccao</div>',
'    <div class="memp" id="mnome"></div>',
'    <textarea id="mtxt" rows="6" placeholder="Gerando mensagem..."></textarea>',
'    <div class="mact">',
'      <button class="btn-fch" onclick="fechar()">Fechar</button>',
'      <button class="btn-wpp" onclick="wpp()">Abrir WhatsApp</button>',
'    </div>',
'  </div>',
'</div>',
'<div class="toast" id="toast"></div>',
'<script>',
'var dados=[];',
'var atual=null;',
'var filtroAtivo="todos";',
'var STATUS_KEY="leadminer_status";',
'',
'// Carrega status salvo no localStorage',
'function loadStatus(){try{return JSON.parse(localStorage.getItem(STATUS_KEY)||"{}");}catch(e){return {};}}',
'function saveStatus(st){try{localStorage.setItem(STATUS_KEY,JSON.stringify(st));}catch(e){}}',
'var statusMap=loadStatus();',
'',
'function pillClass(s){if(s>=80)return "pill hot";if(s>=60)return "pill bom";if(s>=40)return "pill med";return "pill baixo";}',
'function pillTxt(s){if(s>=80)return "HOT "+s;if(s>=60)return "BOM "+s;return String(s);}',
'',
'function getStatusLabel(st){',
'  var m={"pendente":"—","contatado":"📞 Contatado","respondeu":"💬 Respondeu","fechado":"✅ Fechado"};',
'  return m[st]||"—";',
'}',
'',
'async function buscar(){',
'  var nicho=document.getElementById("nicho").value.trim();',
'  if(!nicho){toast("Preencha o nicho","err");return;}',
'  var cidade=document.getElementById("cidade").value.trim();',
'  var btn=document.getElementById("btnB");',
'  btn.disabled=true;btn.textContent="Buscando...";',
'  document.getElementById("loading").style.display="block";',
'  document.getElementById("res").style.display="none";',
'  // Atualiza mensagem de loading dinamicamente',
'  var msgs=["buscando pagina 1 de 10...","varrendo regioes da cidade...","filtrando empresas sem site...","quase la, organizando por score..."];',
'  var mi=0;',
'  var tick=setInterval(function(){mi=(mi+1)%msgs.length;document.getElementById("spinMsg").textContent=msgs[mi];},4000);',
'  try{',
'    var url="/buscar?nicho="+encodeURIComponent(nicho)+(cidade?"&cidade="+encodeURIComponent(cidade):"");',
'    var r=await fetch(url);',
'    var j=await r.json();',
'    clearInterval(tick);',
'    if(j.erro){toast("Erro: "+j.erro,"err");return;}',
'    dados=j.resultados||[];',
'    filtroAtivo="todos";',
'    document.querySelectorAll(".fbtn").forEach(function(b){b.classList.remove("active");});',
'    document.querySelector(".fbtn").classList.add("active");',
'    render();',
'  }catch(e){clearInterval(tick);toast("Falha na conexao","err");}',
'  finally{document.getElementById("loading").style.display="none";btn.disabled=false;btn.textContent="Buscar";}',
'}',
'',
'function dadosFiltrados(){',
'  if(filtroAtivo==="todos")return dados;',
'  return dados.filter(function(d){',
'    var st=statusMap[d.id]||"pendente";',
'    if(filtroAtivo==="pendente")return st==="pendente";',
'    return st===filtroAtivo;',
'  });',
'}',
'',
'function filtrar(btn,tipo){',
'  filtroAtivo=tipo;',
'  document.querySelectorAll(".fbtn").forEach(function(b){b.classList.remove("active");});',
'  btn.classList.add("active");',
'  render();',
'}',
'',
'function render(){',
'  var lista=dadosFiltrados();',
'  document.getElementById("res").style.display="block";',
'  document.getElementById("totalVis").textContent=lista.length;',
'  document.getElementById("totalAll").textContent=dados.length;',
'  document.getElementById("hot").textContent=dados.filter(function(d){return d.score>=80;}).length;',
'  if(lista.length===0){',
'    document.getElementById("tb").style.display="none";',
'    document.getElementById("empty").style.display="block";',
'    return;',
'  }',
'  document.getElementById("tb").style.display="table";',
'  document.getElementById("empty").style.display="none";',
'  var tbody=document.getElementById("tbody");tbody.innerHTML="";',
'  for(var i=0;i<lista.length;i++){',
'    var x=lista[i];',
'    var st=statusMap[x.id]||"pendente";',
'    var tel=x.telefone?"<span class=\\"ttel\\"><a href=\\"tel:"+x.telefone+"\\">"+x.telefone+"</a></span>":"-";',
'    var tr=document.createElement("tr");',
'    tr.className="status-"+st;',
'    tr.setAttribute("data-id",x.id);',
'    tr.innerHTML=',
'      "<td><span class=\\""+pillClass(x.score)+"\\">"+pillTxt(x.score)+"</span></td>"+',
'      "<td class=\\"tnome\\">"+x.nome+"<div class=\\"tend\\">"+x.endereco+"</div></td>"+',
'      "<td>"+x.avaliacoes+"</td>"+',
'      "<td>"+x.nota+"</td>"+',
'      "<td>"+tel+"</td>"+',
'      "<td><select class=\\"status-sel\\" onchange=\\"setStatus(\'"+x.id+"\',this.value,this.closest(\'tr\'))\\">"+',
'        "<option value=\\"pendente\\""+( st==="pendente"?" selected":"")+">— Pendente</option>"+',
'        "<option value=\\"contatado\\""+( st==="contatado"?" selected":"")+">📞 Contatado</option>"+',
'        "<option value=\\"respondeu\\""+( st==="respondeu"?" selected":"")+">💬 Respondeu</option>"+',
'        "<option value=\\"fechado\\""+( st==="fechado"?" selected":"")+">✅ Fechado</option>"+',
'      "</select></td>"+',
'      "<td><button class=\\"btn-msg\\" onclick=\\"msg(\'"+x.id+"\')\\">✦ Msg</button></td>";',
'    tbody.appendChild(tr);',
'  }',
'}',
'',
'function setStatus(id,val,tr){',
'  statusMap[id]=val;',
'  saveStatus(statusMap);',
'  if(tr){tr.className="status-"+val;}',
'  toast("Status salvo","ok");',
'}',
'',
'async function msg(id){',
'  atual=dados.find(function(d){return d.id===id;});',
'  if(!atual)return;',
'  document.getElementById("mnome").textContent=atual.nome;',
'  document.getElementById("mtxt").value="";',
'  document.getElementById("ov").className="overlay open";',
'  document.getElementById("mtxt").placeholder="Gerando com IA...";',
'  try{',
'    var r=await fetch("/mensagem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({empresa:atual})});',
'    var j=await r.json();',
'    if(j.mensagem){document.getElementById("mtxt").placeholder="";document.getElementById("mtxt").value=j.mensagem;}',
'    else{document.getElementById("mtxt").value=msgLocal(atual);}',
'  }catch(e){document.getElementById("mtxt").value=msgLocal(atual);}',
'}',
'',
'function msgLocal(e){',
'  return "Oi! Vi que "+e.nome+" ainda nao tem site proprio.\\n\\nSem site, muitos clientes que buscam online acabam no concorrente.\\n\\nCrio sites profissionais por um preco acessivel. Posso te mostrar exemplos?\\n\\nQual horario e melhor pra conversar?";',
'}',
'',
'function fechar(){document.getElementById("ov").className="overlay";atual=null;}',
'',
'function wpp(){',
'  var txt=document.getElementById("mtxt").value;',
'  var tel=atual&&atual.telefone?atual.telefone.replace(/[^0-9]/g,""):"";',
'  var u=tel?"https://wa.me/55"+tel+"?text="+encodeURIComponent(txt):"https://wa.me/?text="+encodeURIComponent(txt);',
'  window.open(u,"_blank");',
'  // Marca como contatado automaticamente',
'  if(atual){setStatus(atual.id,"contatado",document.querySelector("[data-id=\\""+atual.id+"\\"]"));}',
'}',
'',
'function exportCSV(){',
'  if(!dados.length){toast("Sem dados","err");return;}',
'  var h=["Score","Nome","Telefone","Status"].join(",");',
'  var rows=dados.map(function(x){',
'    var st=statusMap[x.id]||"pendente";',
'    return[x.score,"\\""+x.nome+"\\"",x.telefone,st].join(",");',
'  });',
'  var csv="\\uFEFF"+h+"\\n"+rows.join("\\n");',
'  var b=new Blob([csv],{type:"text/csv;charset=utf-8;"});',
'  var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="leads_"+Date.now()+".csv";a.click();',
'  toast("CSV exportado!","ok");',
'}',
'',
'function toast(msg,type){',
'  var t=document.getElementById("toast");',
'  t.textContent=msg;t.className="toast show "+(type||"");',
'  setTimeout(function(){t.className="toast";},3000);',
'}',
'',
'document.addEventListener("keydown",function(e){if(e.key==="Enter")buscar();});',
'document.getElementById("ov").addEventListener("click",function(e){if(e.target===this)fechar();});',
'</script>',
'</body>',
'</html>'
  ].join('\n');
}
