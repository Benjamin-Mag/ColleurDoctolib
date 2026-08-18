// ============================================================
// CONSTANTES
// ============================================================
var REFERRER_FIXE = 'Audibene';
var MESSAGE_FIXE = 'Rendez-vous Audibene';

// ============================================================
// PANNEAU SALESFORCE — Copier les infos patient
// ============================================================
async function injecterPanelSF(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function(referrerFixe) {
      var existingPanel = document.getElementById('doctolib-copy-panel');
      if (existingPanel) { existingPanel.remove(); return 'removed'; }

      var PANEL_W = 230;
      var STORAGE_KEY = 'doctolibCopyPanelState_v1';

      function getSR(el) { try { return chrome.dom.openOrClosedShadowRoot(el); } catch(e) { return el.shadowRoot; } }
      function dqAll(sel, root) {
        root = root || document;
        var res = Array.from(root.querySelectorAll(sel));
        root.querySelectorAll('*').forEach(function(e) { var sr = getSR(e); if (sr) res = res.concat(dqAll(sel, sr)); });
        return res;
      }
      function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

      function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; } }
      function saveState(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {} }
      function clamp(top, left) {
        var maxLeft = Math.max(0, window.innerWidth - PANEL_W);
        var maxTop = Math.max(0, window.innerHeight - 40);
        return { top: Math.min(Math.max(top, 0), maxTop), left: Math.min(Math.max(left, 0), maxLeft) };
      }

      // Salesforce Console garde souvent plusieurs fiches (onglets internes)
      // montées dans le DOM en même temps. Une fiche inactive est masquée via
      // CSS (taille nulle) — c'est ce qu'on teste ici. On ne doit PAS exiger
      // que l'élément soit dans la zone actuellement scrollée à l'écran :
      // un champ plus bas dans la page (pas encore scrollé jusqu'à lui) a une
      // taille bien réelle, juste hors du viewport pour l'instant.
      function isRendered(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      // Ne JAMAIS retourner un candidat invisible en dernier recours : une Piste
      // restée ouverte en arrière-plan dans un autre onglet Salesforce Console
      // garde ses champs montés dans le DOM (taille 0, donc invisibles) — les
      // renvoyer par défaut faisait remonter le nom du patient de la MAUVAISE
      // fiche quand on copiait depuis une Opportunité (qui n'a pas ces champs).
      function visibleEl(candidates) {
        for (var i = candidates.length - 1; i >= 0; i--) {
          if (isRendered(candidates[i])) return candidates[i];
        }
        return null;
      }

      function fieldValue(labelText) {
        var labels = dqAll('.slds-form-element__label').filter(function(l) {
          return (l.innerText || l.textContent || '').trim() === labelText;
        });
        var lbl = visibleEl(labels);
        if (!lbl) return null;
        var container = lbl.closest('.slds-form-element');
        if (!container) return null;
        var ctrl = container.querySelector('.slds-form-element__control');
        if (!ctrl) return null;
        var txt = (ctrl.innerText || ctrl.textContent || '');
        txt = txt.replace('Modifier ' + labelText, '').trim();
        return txt;
      }

      function expandSection(name) {
        var all = dqAll('*').filter(function(el) {
          return el.children.length === 0 && (el.textContent || '').trim() === name;
        });
        var target = visibleEl(all);
        if (!target) return false;
        var btn = target.closest('button') || target.closest('[role="button"]');
        if (btn) { btn.click(); return true; }
        return false;
      }

      function splitNomEtGenre(nomComplet) {
        var txt = (nomComplet || '').trim();
        var genre = null;
        var m = txt.match(/^(Mme|Madame|Mlle|Mademoiselle)\.?\s+(.*)$/i);
        if (m) { genre = 'F'; txt = m[2]; }
        else {
          m = txt.match(/^(M|Monsieur)\.?\s+(.*)$/i);
          if (m) { genre = 'M'; txt = m[2]; }
        }
        var parts = txt.split(/\s+/).filter(Boolean);
        if (parts.length <= 1) return { genre: genre, prenom: txt || '', nom: '' };
        return { genre: genre, prenom: parts[0], nom: parts.slice(1).join(' ') };
      }

      function normaliserTelephone(tel) {
        if (!tel) return '';
        return tel.replace(/\s+/g, '').replace(/^\+33/, '0');
      }

      // Repli quand on est sur une fiche Opportunité (pas de "Nom complet") :
      // le nom du patient est dans le titre de la fiche, suivi du code postal.
      function nomDepuisTitreOpportunite() {
        var el = visibleEl(dqAll('lightning-formatted-text[slot="primaryField"]'));
        var full = el ? (el.innerText || el.textContent || '').trim() : '';
        var m = full.match(/^(.*?)\s+\d{5}/);
        return m ? m[1].trim() : full;
      }

      // Repli téléphone pour une Opportunité : affiché en clair dans le panneau
      // d'activité ("Numéro mobile/fixe du client :").
      function telephoneDepuisOpportunite() {
        var cols = dqAll('.c_numberColor');
        var pick = visibleEl(cols.filter(function(c) { return /num[ée]ro mobile du client/i.test(c.textContent || ''); }))
          || visibleEl(cols.filter(function(c) { return /num[ée]ro fixe du client/i.test(c.textContent || ''); }));
        if (!pick) return '';
        var m = (pick.textContent || '').match(/(\+?\d[\d\s]{6,})\s*$/);
        return m ? m[1].trim() : '';
      }

      // Reprend la technique de ColleurMailSF (hover sur le lien Account pour
      // révéler le panneau d'aperçu SF, puis extraction de l'adresse dans le
      // texte du panneau) — nécessaire pour que le générateur de mails
      // (boutons "📋 Coller depuis Salesforce") reçoive aussi partenaire/adresse
      // depuis ce même clic, sans avoir à utiliser ColleurMailSF séparément.
      async function extrairePartenaireEtAdresse() {
        var links = dqAll('a[href*="/lightning/r/Account/"]');
        var partLink = visibleEl(links);
        var partenaire = partLink ? (partLink.innerText || partLink.textContent || '').trim() : '';
        var adresse = '';
        if (partLink) {
          var rect = partLink.getBoundingClientRect();
          var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          var opts = { bubbles: true, composed: true, clientX: cx, clientY: cy };
          partLink.dispatchEvent(new PointerEvent('pointerover', opts));
          partLink.dispatchEvent(new MouseEvent('mouseover', opts));
          partLink.dispatchEvent(new MouseEvent('mouseenter', opts));
          var panelText = null;
          for (var a = 0; a < 8; a++) {
            await sleep(250);
            var panel = document.querySelector('.forceHoverPanel[aria-hidden="false"]') || document.querySelector('[class*="forceHoverPanel"]:not([aria-hidden="true"])');
            if (panel) { panelText = (panel.innerText || panel.textContent || '').trim(); break; }
          }
          partLink.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, composed: true }));
          partLink.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, composed: true }));
          if (panelText) {
            var plines = panelText.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            var expIdx = plines.findIndex(function(l) { return /exp[eé]dition|shipping/i.test(l); });
            if (expIdx >= 0) {
              var al = [];
              for (var k = expIdx + 1; k < plines.length && al.length < 3; k++) {
                if (/\d{5}/.test(plines[k]) || (al.length > 0 && plines[k].length > 2)) { al.push(plines[k]); if (/\d{5}/.test(plines[k])) break; }
                else if (al.length === 0) { al.push(plines[k]); }
                else break;
              }
              adresse = al.join(',\n');
            }
            if (!adresse) {
              var cpIdx = plines.findIndex(function(l) { return /\d{5}/.test(l); });
              if (cpIdx >= 0) { var pts = []; if (cpIdx > 0 && plines[cpIdx - 1].length > 2) pts.push(plines[cpIdx - 1]); pts.push(plines[cpIdx]); adresse = pts.join(',\n'); }
            }
          }
        }
        return { partenaire: partenaire, adresse: adresse };
      }

      async function extraireEtCopier() {
        var label = document.getElementById('dtl-copier-label');
        if (label) { label.textContent = '⏳'; }
        try {
          var email = fieldValue('Adresse e-mail');
          var naissance = fieldValue('Date de naissance');
          if (email === null || naissance === null) {
            expandSection('Coordonnées client');
            await sleep(400);
            email = fieldValue('Adresse e-mail');
            naissance = fieldValue('Date de naissance');
          }
          var nomComplet = fieldValue('Nom complet');
          var telMobile = fieldValue('Téléphone mobile');
          var telFixe = fieldValue('Téléphone');
          var telephone = normaliserTelephone(telMobile || telFixe || '');
          var np = splitNomEtGenre(nomComplet);
          if (!np.prenom && !np.nom) {
            np = splitNomEtGenre(nomDepuisTitreOpportunite());
          }
          if (!telephone) {
            telephone = normaliserTelephone(telephoneDepuisOpportunite());
          }
          var pa = await extrairePartenaireEtAdresse();

          var data = {
            genre: np.genre,
            prenom: np.prenom,
            nom: np.nom,
            email: email || '',
            naissance: naissance || '',
            telephone: telephone,
            referrer: referrerFixe,
            patient: [np.prenom, np.nom].filter(Boolean).join(' '),
            partenaire: pa.partenaire,
            adresse: pa.adresse
          };
          await navigator.clipboard.writeText(JSON.stringify(data));
          showStatus([data.patient, data.partenaire].filter(Boolean).join(' / ') + ' copié', true);
        } catch (e) {
          showStatus('Erreur : ' + e.message, false);
        } finally {
          if (label) { label.textContent = '📋 Copier les infos patient'; }
        }
      }

      function showStatus(msg, ok) {
        var st = document.getElementById('dtl-panel-status');
        if (st) { st.textContent = msg; st.style.color = ok ? '#0f6f66' : '#c0392b'; st.style.display = msg ? 'block' : 'none'; }
      }

      var saved = loadState();
      var pos = clamp(
        typeof saved.top === 'number' ? saved.top : 80,
        typeof saved.left === 'number' ? saved.left : (window.innerWidth - PANEL_W - 20)
      );

      var panel = document.createElement('div');
      panel.id = 'doctolib-copy-panel';
      panel.style.cssText =
        'position:fixed;top:' + pos.top + 'px;left:' + pos.left + 'px;width:' + PANEL_W + 'px;' +
        'z-index:2147483647;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);' +
        'font-family:Arial,Helvetica,sans-serif;overflow:hidden;user-select:none;';

      if (!document.getElementById('dtl-bar-btn-style')) {
        var barStyle = document.createElement('style');
        barStyle.id = 'dtl-bar-btn-style';
        barStyle.textContent = '.dtl-bar-btn{transition:filter .1s ease;} .dtl-bar-btn:hover{filter:brightness(1.1);} .dtl-bar-btn:active{filter:brightness(.88);}';
        document.head.appendChild(barStyle);
      }

      var bar = document.createElement('div');
      bar.id = 'dtl-copier-btn';
      bar.className = 'dtl-bar-btn';
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;background:#0f6f66;color:#fff;padding:12px 10px;' +
        'cursor:pointer;font-size:13px;font-weight:600;box-shadow:inset 0 -2px 0 rgba(0,0,0,.12);';
      bar.innerHTML =
        '<span id="dtl-copier-label" style="flex:1;text-align:center;">📋 Copier les infos patient</span>' +
        '<button id="dtl-panel-close" title="Fermer" style="width:20px;height:20px;border:none;border-radius:5px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0;">×</button>';
      panel.appendChild(bar);

      var status = document.createElement('p');
      status.id = 'dtl-panel-status';
      status.style.cssText = 'display:none;margin:0;padding:6px 10px 8px;font-size:11px;color:#555;text-align:center;word-break:break-word;';
      panel.appendChild(status);

      document.body.appendChild(panel);

      var G = window.__doctolibPanelDrag || (window.__doctolibPanelDrag = {});
      G.panel = panel; G.clamp = clamp; G.onClick = extraireEtCopier;

      bar.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        G.downX = e.clientX; G.downY = e.clientY;
        G.startLeft = panel.offsetLeft; G.startTop = panel.offsetTop;
        G.dragging = false;
        e.preventDefault();
      });

      var H = window.__doctolibPanelHandlers;
      if (H) {
        document.removeEventListener('mousemove', H.mousemove);
        document.removeEventListener('mouseup', H.mouseup);
        window.removeEventListener('resize', H.resize);
        document.removeEventListener('click', H.click);
      }
      H = window.__doctolibPanelHandlers = {};
      var DRAG_THRESHOLD = 4;
      H.mousemove = function(e) {
        if (!G.panel || !G.panel.isConnected || G.downX === undefined) return;
        var dx = e.clientX - G.downX, dy = e.clientY - G.downY;
        if (!G.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        G.dragging = true;
        var next = G.clamp(G.startTop + dy, G.startLeft + dx);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.mouseup = function() {
        if (!G.panel || G.downX === undefined) return;
        var wasDragging = G.dragging;
        if (wasDragging) {
          try {
            var s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
            s.top = G.panel.offsetTop; s.left = G.panel.offsetLeft;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
          } catch (e) {}
        }
        G.downX = undefined; G.dragging = false;
        if (!wasDragging && G.onClick) G.onClick();
      };
      H.resize = function() {
        if (!G.panel || !G.panel.isConnected) return;
        var next = G.clamp(G.panel.offsetTop, G.panel.offsetLeft);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.click = function(e) {
        if (!G.panel || !G.panel.isConnected || G.panel.contains(e.target)) return;
        var st = document.getElementById('dtl-panel-status');
        if (st) { st.style.display = 'none'; st.textContent = ''; }
      };
      document.addEventListener('mousemove', H.mousemove);
      document.addEventListener('mouseup', H.mouseup);
      window.addEventListener('resize', H.resize);
      document.addEventListener('click', H.click);

      document.getElementById('dtl-panel-close').addEventListener('click', function() { panel.remove(); });

      return 'injected';
    },
    args: [REFERRER_FIXE]
  });
}

// ============================================================
// PANNEAU DOCTOLIB — Coller les infos patient
// ============================================================
async function injecterPanelDoctolib(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function(referrerFixe, messageFixe) {
      var existingPanel = document.getElementById('doctolib-paste-panel');
      if (existingPanel) { existingPanel.remove(); return 'removed'; }

      var PANEL_W = 230;
      var STORAGE_KEY = 'doctolibPastePanelState_v1';

      function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; } }
      function saveState(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {} }
      function clamp(top, left) {
        var maxLeft = Math.max(0, window.innerWidth - PANEL_W);
        var maxTop = Math.max(0, window.innerHeight - 40);
        return { top: Math.min(Math.max(top, 0), maxTop), left: Math.min(Math.max(left, 0), maxLeft) };
      }
      function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

      // Détecte le type de fiche Doctolib et renvoie le document/fenêtre à utiliser
      // ainsi que la correspondance des ids de champs pour ce type de fiche.
      function getContext() {
        if (/\/admin\/front-desk\//i.test(location.href)) {
          var iframe = document.getElementById('agenda-iframe');
          if (!iframe) return null;
          var doc, win;
          try { doc = iframe.contentDocument; win = iframe.contentWindow; } catch (e) { return null; }
          if (!doc || !doc.getElementById('patient.first_name')) return null;
          return {
            doc: doc,
            win: win,
            ids: {
              referrer: 'referrer',
              // La civilité prend des formes différentes selon le cabinet :
              // certains affichent "Civilité" (M./Mme), d'autres "Sexe
              // biologique" (Homme/Femme) — on essaie chaque variante connue.
              genderTrueCandidates: ['patient-gender-true', 'patient-biological_sex-female'],
              genderFalseCandidates: ['patient-gender-false', 'patient-biological_sex-male'],
              genderNullCandidates: ['patient-gender-null'],
              first_name: 'patient.first_name',
              last_name: 'patient.last_name',
              maiden_name: 'patient.maiden_name',
              birthdate: 'patient.birthdate',
              place_of_birth_type: 'patient.place_of_birth_type',
              phone_number: 'patient.phone_number',
              email: 'patient.email',
              message: 'notes'
            }
          };
        }
        return {
          doc: document,
          win: window,
          ids: {
            referrer: 'referrer',
            genderTrueCandidates: ['gender-true'],
            genderFalseCandidates: ['gender-false'],
            first_name: 'first_name',
            last_name: 'last_name',
            maiden_name: 'maiden_name',
            birthdate: 'birthdate',
            place_of_birth_type: 'place_of_birth_type',
            phone_number: 'phone_number',
            email: 'email',
            message: 'referrer_message'
          }
        };
      }

      function showStatus(msg, ok) {
        var st = document.getElementById('dtl-paste-status');
        if (st) { st.textContent = msg; st.style.color = ok ? '#0f6f66' : '#c0392b'; st.style.display = msg ? 'block' : 'none'; }
      }

      async function collerInfos() {
        var label = document.getElementById('dtl-coller-label');
        if (label) { label.textContent = '⏳'; }
        try {
          var ctx = getContext();
          if (!ctx) { showStatus('Formulaire patient introuvable — ouvre le panneau de création de RDV', false); return; }
          var doc = ctx.doc, win = ctx.win, ids = ctx.ids;

          function setVal(el, value) {
            if (!el || value === undefined || value === null) return;
            var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, value);
            el.dispatchEvent(new win.Event('input', { bubbles: true }));
            el.dispatchEvent(new win.Event('change', { bubbles: true }));
          }

          // Écrase toujours le champ, y compris en le vidant si value est
          // absent — sinon une valeur laissée par un collage précédent
          // (patient différent) resterait affichée par erreur.
          function fillField(id, value) {
            var el = doc.getElementById(id);
            if (!el) return false;
            setVal(el, value || '');
            return true;
          }

          function selectGenre(genre) {
            var candidates = genre === 'F' ? ids.genderTrueCandidates
              : genre === 'M' ? ids.genderFalseCandidates
              : ids.genderNullCandidates;
            if (!candidates) return false;
            for (var i = 0; i < candidates.length; i++) {
              var el = doc.getElementById(candidates[i]);
              if (el) { el.click(); return true; }
            }
            return false;
          }

          async function selectLieuNaissanceInconnu() {
            var trigger = doc.getElementById(ids.place_of_birth_type);
            if (!trigger) return false;
            trigger.click();
            for (var i = 0; i < 15; i++) {
              await sleep(100);
              var opts = Array.from(doc.querySelectorAll('[role="option"]'));
              var target = opts.find(function(o) { return (o.innerText || o.textContent || '').trim() === 'Lieu de naissance inconnu'; });
              if (target) { target.click(); return true; }
            }
            return false;
          }

          var text = await navigator.clipboard.readText();
          if (!text) { showStatus('Presse-papier vide', false); return; }
          var data;
          try { data = JSON.parse(text); } catch (e) { showStatus('Presse-papier invalide (pas de fiche copiée)', false); return; }

          var found = false;
          found = fillField(ids.referrer, data.referrer || referrerFixe) || found;
          found = selectGenre(data.genre) || found;
          found = fillField(ids.first_name, data.prenom) || found;
          found = fillField(ids.last_name, data.nom) || found;
          found = fillField(ids.maiden_name, data.nom) || found;
          found = fillField(ids.birthdate, data.naissance) || found;
          found = (await selectLieuNaissanceInconnu()) || found;
          found = fillField(ids.phone_number, data.telephone) || found;
          found = fillField(ids.email, data.email) || found;
          found = fillField(ids.message, messageFixe) || found;

          if (!found) { showStatus('Aucun champ Doctolib trouvé sur cette page', false); return; }
          showStatus([data.prenom, data.nom].filter(Boolean).join(' ') + ' collé !', true);
        } catch (e) {
          showStatus('Erreur : ' + e.message, false);
        } finally {
          if (label) { label.textContent = '📨 Coller sur Doctolib'; }
        }
      }

      var saved = loadState();
      var pos = clamp(
        typeof saved.top === 'number' ? saved.top : 80,
        typeof saved.left === 'number' ? saved.left : (window.innerWidth - PANEL_W - 20)
      );

      var panel = document.createElement('div');
      panel.id = 'doctolib-paste-panel';
      panel.style.cssText =
        'position:fixed;top:' + pos.top + 'px;left:' + pos.left + 'px;width:' + PANEL_W + 'px;' +
        'z-index:2147483647;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);' +
        'font-family:Arial,Helvetica,sans-serif;overflow:hidden;user-select:none;';

      if (!document.getElementById('dtl-bar-btn-style')) {
        var barStyle = document.createElement('style');
        barStyle.id = 'dtl-bar-btn-style';
        barStyle.textContent = '.dtl-bar-btn{transition:filter .1s ease;} .dtl-bar-btn:hover{filter:brightness(1.1);} .dtl-bar-btn:active{filter:brightness(.88);}';
        document.head.appendChild(barStyle);
      }

      var bar = document.createElement('div');
      bar.id = 'dtl-coller-btn';
      bar.className = 'dtl-bar-btn';
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;background:#0f6f66;color:#fff;padding:12px 10px;' +
        'cursor:pointer;font-size:13px;font-weight:600;box-shadow:inset 0 -2px 0 rgba(0,0,0,.12);';
      bar.innerHTML =
        '<span id="dtl-coller-label" style="flex:1;text-align:center;">📨 Coller sur Doctolib</span>' +
        '<button id="dtl-paste-panel-close" title="Fermer" style="width:20px;height:20px;border:none;border-radius:5px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0;">×</button>';
      panel.appendChild(bar);

      var status = document.createElement('p');
      status.id = 'dtl-paste-status';
      status.style.cssText = 'display:none;margin:0;padding:6px 10px 8px;font-size:11px;color:#555;text-align:center;word-break:break-word;';
      panel.appendChild(status);

      document.body.appendChild(panel);

      var G = window.__doctolibPastePanelDrag || (window.__doctolibPastePanelDrag = {});
      G.panel = panel; G.clamp = clamp; G.onClick = collerInfos;

      bar.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        G.downX = e.clientX; G.downY = e.clientY;
        G.startLeft = panel.offsetLeft; G.startTop = panel.offsetTop;
        G.dragging = false;
        e.preventDefault();
      });

      var H = window.__doctolibPastePanelHandlers;
      if (H) {
        document.removeEventListener('mousemove', H.mousemove);
        document.removeEventListener('mouseup', H.mouseup);
        window.removeEventListener('resize', H.resize);
        document.removeEventListener('click', H.click);
      }
      H = window.__doctolibPastePanelHandlers = {};
      var DRAG_THRESHOLD = 4;
      H.mousemove = function(e) {
        if (!G.panel || !G.panel.isConnected || G.downX === undefined) return;
        var dx = e.clientX - G.downX, dy = e.clientY - G.downY;
        if (!G.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        G.dragging = true;
        var next = G.clamp(G.startTop + dy, G.startLeft + dx);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.mouseup = function() {
        if (!G.panel || G.downX === undefined) return;
        var wasDragging = G.dragging;
        if (wasDragging) {
          try {
            var s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
            s.top = G.panel.offsetTop; s.left = G.panel.offsetLeft;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
          } catch (e) {}
        }
        G.downX = undefined; G.dragging = false;
        if (!wasDragging && G.onClick) G.onClick();
      };
      H.resize = function() {
        if (!G.panel || !G.panel.isConnected) return;
        var next = G.clamp(G.panel.offsetTop, G.panel.offsetLeft);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.click = function(e) {
        if (!G.panel || !G.panel.isConnected || G.panel.contains(e.target)) return;
        var st = document.getElementById('dtl-paste-status');
        if (st) { st.style.display = 'none'; st.textContent = ''; }
      };
      document.addEventListener('mousemove', H.mousemove);
      document.addEventListener('mouseup', H.mouseup);
      window.addEventListener('resize', H.resize);
      document.addEventListener('click', H.click);

      document.getElementById('dtl-paste-panel-close').addEventListener('click', function() { panel.remove(); });

      return 'injected';
    },
    args: [REFERRER_FIXE, MESSAGE_FIXE]
  });
}

// ============================================================
// PANNEAU ACUITIS — Coller les infos patient
// ============================================================
// Le widget de RDV Acuitis (rdv.acuitis.com) est parfois affiché en iframe
// cross-origin dans une page fr.acuitis.com, parfois en page autonome.
// allFrames:true injecte dans toutes les frames ; chaque instance vérifie
// si ELLE est la frame rdv.acuitis.com avant de construire le panneau —
// ça couvre les deux cas sans messagerie cross-frame.
async function injecterPanelAcuitis(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: function(messageFixe) {
      // L'iframe rdv.acuitis.com (cross-origin) n'a pas la permission de lire
      // le presse-papier (Permissions-Policy du navigateur). Seule la frame
      // top-level en a le droit. On y installe donc un "relais" : la frame
      // top répond aux demandes de lecture presse-papier envoyées via
      // postMessage par n'importe quelle frame de l'onglet (dont l'iframe).
      if (window === window.top) {
        if (!window.__colleurDoctolibClipboardBroker) {
          window.__colleurDoctolibClipboardBroker = true;
          window.addEventListener('message', function(e) {
            if (!e.data || e.data.__colleurDoctolibClipboardRequest !== true) return;
            navigator.clipboard.readText().then(function(text) {
              e.source.postMessage({ __colleurDoctolibClipboardResponse: true, text: text }, '*');
            }, function(err) {
              e.source.postMessage({ __colleurDoctolibClipboardResponse: true, text: '', error: err.message }, '*');
            });
          });
        }
      }

      if (!/(^|\.)rdv\.acuitis\.com$/i.test(location.hostname)) return;

      function requestClipboardText() {
        return new Promise(function(resolve, reject) {
          var done = false;
          function handler(e) {
            if (!e.data || e.data.__colleurDoctolibClipboardResponse !== true) return;
            done = true;
            window.removeEventListener('message', handler);
            resolve(e.data.text || '');
          }
          window.addEventListener('message', handler);
          window.top.postMessage({ __colleurDoctolibClipboardRequest: true }, '*');
          setTimeout(function() {
            if (done) return;
            window.removeEventListener('message', handler);
            reject(new Error('Délai dépassé pour lire le presse-papier'));
          }, 3000);
        });
      }

      var existingPanel = document.getElementById('acuitis-paste-panel');
      if (existingPanel) { existingPanel.remove(); return 'removed'; }

      var PANEL_W = 230;
      var STORAGE_KEY = 'acuitisPastePanelState_v1';

      function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; } }
      function saveState(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {} }
      function clamp(top, left) {
        var maxLeft = Math.max(0, document.documentElement.scrollWidth - PANEL_W);
        var maxTop = Math.max(0, document.documentElement.scrollHeight - 40);
        return { top: Math.min(Math.max(top, 0), maxTop), left: Math.min(Math.max(left, 0), maxLeft) };
      }

      // Ce widget agrandit son iframe pour égaler la hauteur de son contenu
      // (pas de scroll interne) : "position:fixed" s'ancre donc près du HAUT
      // du document entier, pas de la zone visible à l'écran — invisible une
      // fois qu'on a défilé jusqu'à l'étape "Coordonnées". On ancre donc le
      // panneau (position:absolute) juste à côté du champ Nom à la place.
      function getDocOffsetTop(el) {
        var top = 0;
        while (el) { top += el.offsetTop || 0; el = el.offsetParent; }
        return top;
      }

      function setVal(el, value) {
        if (!el || value === undefined || value === null) return;
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
          : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Écrase toujours le champ, y compris en le vidant si value est absent
      // — sinon une valeur laissée par un collage précédent (patient
      // différent) resterait affichée par erreur.
      function fillField(id, value) {
        var el = document.getElementById(id);
        if (!el) return false;
        setVal(el, value || '');
        return true;
      }

      function showStatus(msg, ok) {
        var st = document.getElementById('acx-paste-status');
        if (st) { st.textContent = msg; st.style.color = ok ? '#0f6f66' : '#c0392b'; st.style.display = msg ? 'block' : 'none'; }
      }

      async function collerInfos() {
        var label = document.getElementById('acx-coller-label');
        if (label) { label.textContent = '⏳'; }
        try {
          var text = await requestClipboardText();
          if (!text) { showStatus('Presse-papier vide', false); return; }
          var data;
          try { data = JSON.parse(text); } catch (e) { showStatus('Presse-papier invalide (pas de fiche copiée)', false); return; }

          var found = false;
          found = fillField('name', data.nom) || found;
          found = fillField('firstname', data.prenom) || found;
          var tel = document.querySelector('input[type="tel"]');
          if (tel) { setVal(tel, data.telephone || ''); found = true; }
          found = fillField('email', data.email) || found;
          var parts = (data.naissance || '').split('/');
          var day = 'no', month = '', year = ''; // valeurs des options "Sélectionnez..." (vide)
          if (parts.length === 3) {
            day = String(parseInt(parts[0], 10));
            month = String(parseInt(parts[1], 10));
            year = parts[2];
          }
          found = fillField('birthdateDay', day) || found;
          found = fillField('birthdateMonth', month) || found;
          found = fillField('birthdateYear', year) || found;
          found = fillField('remarque', messageFixe) || found;

          if (!found) { showStatus('Aucun champ trouvé sur cette page', false); return; }
          showStatus([data.prenom, data.nom].filter(Boolean).join(' ') + ' collé !', true);
        } catch (e) {
          showStatus('Erreur : ' + e.message, false);
        } finally {
          if (label) { label.textContent = '📨 Coller sur Acuitis'; }
        }
      }

      var anchorEl = document.getElementById('name');
      var defaultTop = anchorEl ? Math.max(0, getDocOffsetTop(anchorEl) - 60) : 20;

      var saved = loadState();
      var pos = clamp(
        typeof saved.top === 'number' ? saved.top : defaultTop,
        typeof saved.left === 'number' ? saved.left : (document.documentElement.clientWidth - PANEL_W - 20)
      );

      var panel = document.createElement('div');
      panel.id = 'acuitis-paste-panel';
      panel.style.cssText =
        'position:absolute;top:' + pos.top + 'px;left:' + pos.left + 'px;width:' + PANEL_W + 'px;' +
        'z-index:2147483647;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);' +
        'font-family:Arial,Helvetica,sans-serif;overflow:hidden;user-select:none;';

      if (!document.getElementById('dtl-bar-btn-style')) {
        var barStyle = document.createElement('style');
        barStyle.id = 'dtl-bar-btn-style';
        barStyle.textContent = '.dtl-bar-btn{transition:filter .1s ease;} .dtl-bar-btn:hover{filter:brightness(1.1);} .dtl-bar-btn:active{filter:brightness(.88);}';
        document.head.appendChild(barStyle);
      }

      var bar = document.createElement('div');
      bar.id = 'acx-coller-btn';
      bar.className = 'dtl-bar-btn';
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;background:#0f6f66;color:#fff;padding:12px 10px;' +
        'cursor:pointer;font-size:13px;font-weight:600;box-shadow:inset 0 -2px 0 rgba(0,0,0,.12);';
      bar.innerHTML =
        '<span id="acx-coller-label" style="flex:1;text-align:center;">📨 Coller sur Acuitis</span>' +
        '<button id="acx-panel-close" title="Fermer" style="width:20px;height:20px;border:none;border-radius:5px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0;">×</button>';
      panel.appendChild(bar);

      var status = document.createElement('p');
      status.id = 'acx-paste-status';
      status.style.cssText = 'display:none;margin:0;padding:6px 10px 8px;font-size:11px;color:#555;text-align:center;word-break:break-word;';
      panel.appendChild(status);

      document.body.appendChild(panel);

      var G = window.__acuitisPanelDrag || (window.__acuitisPanelDrag = {});
      G.panel = panel; G.clamp = clamp; G.onClick = collerInfos;

      bar.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        G.downX = e.clientX; G.downY = e.clientY;
        G.startLeft = panel.offsetLeft; G.startTop = panel.offsetTop;
        G.dragging = false;
        e.preventDefault();
      });

      var H = window.__acuitisPanelHandlers;
      if (H) {
        document.removeEventListener('mousemove', H.mousemove);
        document.removeEventListener('mouseup', H.mouseup);
        window.removeEventListener('resize', H.resize);
        document.removeEventListener('click', H.click);
      }
      H = window.__acuitisPanelHandlers = {};
      var DRAG_THRESHOLD = 4;
      H.mousemove = function(e) {
        if (!G.panel || !G.panel.isConnected || G.downX === undefined) return;
        var dx = e.clientX - G.downX, dy = e.clientY - G.downY;
        if (!G.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        G.dragging = true;
        var next = G.clamp(G.startTop + dy, G.startLeft + dx);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.mouseup = function() {
        if (!G.panel || G.downX === undefined) return;
        var wasDragging = G.dragging;
        if (wasDragging) {
          try {
            var s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
            s.top = G.panel.offsetTop; s.left = G.panel.offsetLeft;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
          } catch (e) {}
        }
        G.downX = undefined; G.dragging = false;
        if (!wasDragging && G.onClick) G.onClick();
      };
      H.resize = function() {
        if (!G.panel || !G.panel.isConnected) return;
        var next = G.clamp(G.panel.offsetTop, G.panel.offsetLeft);
        G.panel.style.top = next.top + 'px';
        G.panel.style.left = next.left + 'px';
      };
      H.click = function(e) {
        if (!G.panel || !G.panel.isConnected || G.panel.contains(e.target)) return;
        var st = document.getElementById('acx-paste-status');
        if (st) { st.style.display = 'none'; st.textContent = ''; }
      };
      document.addEventListener('mousemove', H.mousemove);
      document.addEventListener('mouseup', H.mouseup);
      window.addEventListener('resize', H.resize);
      document.addEventListener('click', H.click);

      document.getElementById('acx-panel-close').addEventListener('click', function() { panel.remove(); });

      return 'injected';
    },
    args: [MESSAGE_FIXE]
  });
}

// ============================================================
// DÉMARRAGE
// ============================================================
document.addEventListener('DOMContentLoaded', async function() {
  var status = document.getElementById('status');
  var [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  if (/force\.com|salesforce\.com/i.test(tab.url)) {
    await injecterPanelSF(tab);
    window.close();
    return;
  }
  if (/doctolib\.fr/i.test(tab.url)) {
    await injecterPanelDoctolib(tab);
    window.close();
    return;
  }
  if (/acuitis\.com/i.test(tab.url)) {
    await injecterPanelAcuitis(tab);
    window.close();
    return;
  }
  if (status) { status.textContent = 'Ouvre une fiche Salesforce ou une page Doctolib.'; }
});
