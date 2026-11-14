/* ============================================================
   LAVE AUTO DU PARC — Worker : paiement en ligne (Stripe)
   ------------------------------------------------------------
   Ce fichier ne s'occupe que de deux adresses :
     POST /api/create-checkout   crée la page de paiement Stripe
     POST /api/stripe-webhook    reçoit la confirmation de Stripe
   Tout le reste du site (index.html, pages, images) est servi tel
   quel par Cloudflare, sans passer par ce code.

   Variables secrètes (Cloudflare → Workers → laveautoduparc →
   Paramètres → Variables et secrets, type « Secret ») :
     STRIPE_SECRET_KEY       clé secrète Stripe (sk_test_... puis sk_live_...)
     STRIPE_WEBHOOK_SECRET   secret de signature du webhook (whsec_...)
   ⚠️ Ne mettez JAMAIS ces clés dans le code.

   Les prix ci-dessous sont copiés automatiquement depuis index.html.
   Le serveur recalcule TOUJOURS le prix lui-même : le prix envoyé
   par le navigateur n'est jamais utilisé.
   ============================================================ */

const SUPABASE = {
  url: "https://ffaqltodrqwjzsnypnzj.supabase.co",
  anonKey: "sb_publishable_z4w8Jd92KUVwB_584Byu4w_y-0w4bSK"
};
const NOTIF_NTFY = "ldp-resa-p5k6dte9emu8ey";

const PRIX = {
  "Lavage extérieur": {"2 places": 25, "5 places, VUS": 30, "7 places, fourgonnette, camionnette": 35},
  "Lavage intérieur": {"2 places": 25, "5 places, VUS": 30, "7 places, fourgonnette, camionnette": 35},
  "Basic":  {"2 places": 30,  "5 places, VUS": 40,  "7 places, fourgonnette, camionnette": 45},
  "Super":  {"2 places": 55,  "5 places, VUS": 65,  "7 places, fourgonnette, camionnette": 75},
  "Deluxe": {"2 places": 200, "5 places, VUS": 235, "7 places, fourgonnette, camionnette": 280}
};
const EXTRAS = {
  "phares":     {nom: "Restauration des phares", prix: 90},
  "hydrophobe": {nom: "Traitement hydrophobe",    prix: 55}
};

function prixDe(service, taille){
  if (service === "Sans lavage") return 0;
  return (PRIX[service] && PRIX[service][taille]) || 0;
}
function extrasTotal(cles){
  return cles.reduce((s, k) => s + ((EXTRAS[k] && EXTRAS[k].prix) || 0), 0);
}
function calculRabais(montant, promo){
  if (!promo || !montant) return 0;
  if (promo.type === "montant") return Math.min(Number(promo.valeur) || 0, montant);
  return Math.round(montant * ((Number(promo.valeur) || 0) / 100));
}
function dateStrLocale(d){
  return d.toLocaleDateString("sv-SE", { timeZone: "America/Toronto" });  /* AAAA-MM-JJ */
}
function promoValide(promos, code){
  const c = (code || "").trim().toUpperCase();
  if (!c || !Array.isArray(promos)) return null;
  const auj = dateStrLocale(new Date());
  return promos.find(p => (p.code || "").toUpperCase() === c && p.actif !== false &&
    (!p.debut || auj >= p.debut) && (!p.fin || auj <= p.fin)) || null;
}
async function lirePromos(){
  try {
    const res = await fetch(SUPABASE.url + "/rest/v1/parametres?select=valeur&cle=eq.promos", {
      headers: { "apikey": SUPABASE.anonKey }
    });
    if (!res.ok) return [];
    const j = await res.json().catch(() => []);
    return (j && j[0] && Array.isArray(j[0].valeur)) ? j[0].valeur : [];
  } catch(e){ return []; }
}
function reponseJson(corps, statut){
  return new Response(JSON.stringify(corps), {
    status: statut || 200, headers: { "Content-Type": "application/json" }
  });
}
/* L'API Stripe attend du x-www-form-urlencoded avec notation à crochets. */
function versParamsStripe(obj, params, prefixe){
  for (const cle in obj){
    if (!Object.prototype.hasOwnProperty.call(obj, cle)) continue;
    const val = obj[cle];
    const nomComplet = prefixe ? prefixe + "[" + cle + "]" : cle;
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)){
      val.forEach((v, i) => {
        if (v !== null && typeof v === "object") versParamsStripe(v, params, nomComplet + "[" + i + "]");
        else params.append(nomComplet + "[" + i + "]", String(v));
      });
    } else if (typeof val === "object"){
      versParamsStripe(val, params, nomComplet);
    } else {
      params.append(nomComplet, String(val));
    }
  }
}

/* ============================ 1. Créer la page de paiement ============================ */
async function creerPaiement(request, env){
  if (!env.STRIPE_SECRET_KEY){
    return reponseJson({ error: "Le paiement en ligne n'est pas encore configuré (clé Stripe manquante)." }, 500);
  }
  let corps;
  try { corps = await request.json(); } catch(e){ return reponseJson({ error: "Requête invalide." }, 400); }

  const d = {
    nom: String(corps.nom || "").trim().slice(0, 120),
    tel: String(corps.tel || "").trim().slice(0, 30),
    service: String(corps.service || "").trim(),
    taille: String(corps.taille || "").trim(),
    date: String(corps.date || "").trim(),
    heure: String(corps.heure || "").trim(),
    vehicule: String(corps.vehicule || "").trim().slice(0, 120),
    notes: String(corps.notes || "").trim().slice(0, 400),
    extras: Array.isArray(corps.extras) ? corps.extras.filter(k => EXTRAS[k]) : [],
    code_promo: corps.code_promo ? String(corps.code_promo).trim().toUpperCase().slice(0, 40) : ""
  };
  const anglais = corps.lang === "en";

  if (!d.nom || !d.tel || !d.service || !d.taille || !d.date || !d.heure){
    return reponseJson({ error: "Champs obligatoires manquants." }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}$/.test(d.heure)){
    return reponseJson({ error: "Date ou heure invalide." }, 400);
  }
  if (d.service !== "Sans lavage" && !PRIX[d.service]){
    return reponseJson({ error: "Forfait inconnu." }, 400);
  }
  if (d.service === "Sans lavage" && !d.extras.length){
    return reponseJson({ error: "Sélectionnez au moins une option supplémentaire." }, 400);
  }
  const sousTotal = prixDe(d.service, d.taille) + extrasTotal(d.extras);
  if (sousTotal <= 0) return reponseJson({ error: "Le prix calculé est invalide." }, 400);

  let rabais = 0;
  if (d.code_promo){
    const promo = promoValide(await lirePromos(), d.code_promo);
    if (promo) rabais = calculRabais(sousTotal, promo);   /* code invalide : on ignore, on ne bloque pas */
  }
  const total = Math.max(sousTotal - rabais, 0);
  if (total <= 0) return reponseJson({ error: "Le montant à payer est invalide." }, 400);

  const origine = new URL(request.url).origin;
  const nomsExtras = d.extras.map(k => EXTRAS[k].nom);
  const nomProduit = d.service + " — " + d.taille + (nomsExtras.length ? " + " + nomsExtras.join(", ") : "");

  const params = new URLSearchParams();
  versParamsStripe({
    mode: "payment",
    success_url: origine + "/?paiement=succes&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: origine + "/?paiement=annule",
    locale: anglais ? "en" : "fr",
    submit_type: "pay",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "cad",
        unit_amount: Math.round(total * 100),
        product_data: {
          name: nomProduit.slice(0, 250),
          description: "Lave-Auto du Parc"
        }
      }
    }],
    metadata: {
      nom: d.nom, tel: d.tel, service: d.service, taille: d.taille,
      date: d.date, heure: d.heure, vehicule: d.vehicule, notes: d.notes,
      extras: nomsExtras.join(", "), code_promo: d.code_promo,
      sous_total: String(sousTotal), rabais: String(rabais)
    }
  }, params);

  let stripeRes;
  try {
    stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
  } catch(e){
    return reponseJson({ error: "Impossible de joindre Stripe pour le moment." }, 502);
  }
  const j = await stripeRes.json().catch(() => null);
  if (!stripeRes.ok || !j || !j.url){
    return reponseJson({ error: (j && j.error && j.error.message) || "Erreur Stripe inconnue." }, 502);
  }
  return reponseJson({ url: j.url });
}

/* ============================ 2. Confirmation de paiement (webhook) ============================ */
async function signatureValide(corpsBrut, entete, secret){
  if (!entete) return false;
  const morceaux = {};
  entete.split(",").forEach(p => { const i = p.indexOf("="); if (i > 0) morceaux[p.slice(0, i)] = p.slice(i + 1); });
  const t = morceaux.t, v1 = morceaux.v1;
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;   /* anti-rejeu */
  const enc = new TextEncoder();
  const cle = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cle, enc.encode(t + "." + corpsBrut));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
function idReservation(){
  return "R" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}
async function notifier(r){
  if (!NOTIF_NTFY) return;
  try {
    const dateLisible = new Date(r.date + "T12:00:00").toLocaleDateString("fr-CA",
      { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const dateCourte = new Date(r.date + "T12:00:00").toLocaleDateString("fr-CA",
      { weekday: "short", day: "numeric", month: "short" });
    const lignes = [
      "💳 PAYÉ EN LIGNE",
      "👤 " + r.nom + "  ·  " + r.tel,
      "📅 " + dateLisible + "  à  " + r.heure,
      "🧽 " + r.service + "  ·  " + r.prix + " $",
      "🚗 " + r.taille + (r.vehicule ? "  ·  " + r.vehicule : "")
    ];
    if (r.extras) lignes.push("✨ " + r.extras);
    if (r.code_promo) lignes.push("🏷️ " + r.code_promo);
    if (r.notes) lignes.push("📝 " + r.notes);
    await fetch("https://ntfy.sh/", {
      method: "POST",
      body: JSON.stringify({
        topic: NOTIF_NTFY,
        title: "💰 Réservation payée — " + r.nom + "  ·  " + dateCourte + " " + r.heure,
        message: lignes.join("\n"), tags: ["moneybag", "white_check_mark"], priority: 4,
        click: "https://laveautoduparc.ca/#admin"
      })
    }).catch(() => {});
  } catch(e){ /* une notification manquée ne fait jamais échouer le webhook */ }
}
async function consommerPromo(code, tel){
  if (!code) return;
  try {
    await fetch(SUPABASE.url + "/rest/v1/promos_utilisations", {
      method: "POST",
      headers: { "apikey": SUPABASE.anonKey, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ code: code.toUpperCase(), tel })
    });
  } catch(e){ /* pas bloquant : le client a déjà payé */ }
}
async function enregistrerReservation(session){
  const m = session.metadata || {};
  const r = {
    id: idReservation(), cree: new Date().toISOString(), statut: "nouvelle",
    nom: m.nom || "", tel: m.tel || "", service: m.service || "", taille: m.taille || "",
    date: m.date || "", heure: m.heure || "", vehicule: m.vehicule || "", notes: m.notes || "",
    extras: m.extras || "",
    prix: typeof session.amount_total === "number" ? session.amount_total / 100 : Number(m.sous_total || 0),
    paiement_statut: "payee", stripe_session_id: session.id, paiement_recu_le: new Date().toISOString()
  };
  if (m.code_promo) r.code_promo = m.code_promo;

  const res = await fetch(SUPABASE.url + "/rest/v1/reservations", {
    method: "POST",
    headers: { "apikey": SUPABASE.anonKey, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify(r)
  });
  /* 409 = cette session Stripe est déjà enregistrée (Stripe a rejoué l'appel) : tout va bien. */
  if (!res.ok && res.status !== 409){
    throw new Error("Échec de l'enregistrement Supabase (" + res.status + ").");
  }
  if (res.status === 409) return;
  if (m.code_promo) await consommerPromo(m.code_promo, m.tel);
  /* La notification ntfy est envoyée par Supabase (trigger pg_net), plus fiable que depuis ce Worker. */
}
async function recevoirWebhook(request, env){
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Webhook non configuré.", { status: 500 });
  const corpsBrut = await request.text();
  const entete = request.headers.get("Stripe-Signature");
  if (!(await signatureValide(corpsBrut, entete, env.STRIPE_WEBHOOK_SECRET))){
    return new Response("Signature invalide.", { status: 400 });
  }
  let event;
  try { event = JSON.parse(corpsBrut); } catch(e){ return new Response("JSON invalide.", { status: 400 }); }
  if (event.type === "checkout.session.completed"){
    const session = event.data && event.data.object;
    if (session && session.payment_status === "paid"){
      try { await enregistrerReservation(session); }
      catch(e){ return new Response("Erreur d'enregistrement : " + e.message, { status: 500 }); }  /* Stripe réessaiera */
    }
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/* ============================ Point d'entrée ============================ */
export default {
  async fetch(request, env){
    const chemin = new URL(request.url).pathname;
    if (chemin === "/api/create-checkout"){
      return request.method === "POST" ? creerPaiement(request, env) : new Response("Méthode non permise.", { status: 405 });
    }
    if (chemin === "/api/stripe-webhook"){
      return request.method === "POST" ? recevoirWebhook(request, env) : new Response("Méthode non permise.", { status: 405 });
    }
    return env.ASSETS.fetch(request);   /* tout le reste : le site */
  }
};
