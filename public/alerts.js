// Shared by the public pages and the admin dashboard.

// A WhatsApp link for a South African number, however it was typed:
// "068 535 3186", "0685353186", "27685353186" and "+27 68 535 3186" all
// become wa.me/27685353186. (Prefixing "27" to "0685353186" gave
// wa.me/270685353186, a number that does not exist.)
function waNumber(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return '27' + d.slice(1);
  return d;
}
function waLink(input) { return 'https://wa.me/' + waNumber(input); }

// Anything a visitor typed must go through this before it is put into HTML.
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ALERT_CONSENT = 'I agree that Soweto & Roodepoort Properties may send me WhatsApp messages about new listings that match this search. My number is used for nothing else, and I can stop the alerts at any time.';

// The "get a WhatsApp alert" card on the rent and buy pages.
// opts: { type: 'Rent' | 'Sale', suburbs, propertyTypes }
function mountAlertSignup(el, opts) {
  const isRent = opts.type === 'Rent';
  const options = list => list.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  el.innerHTML = `
    <div class="alert-card">
      <div class="alert-intro">
        <h3><i class="fab fa-whatsapp"></i> Not found the right place yet?</h3>
        <p>Tell us what you are looking for. When a place that fits is listed, we will send it to you on WhatsApp.</p>
        <ul>
          <li><i class="fas fa-check"></i> Free, no account needed</li>
          <li><i class="fas fa-check"></i> Only places that match your search</li>
          <li><i class="fas fa-check"></i> Stop any time</li>
        </ul>
      </div>
      <form class="alert-form" novalidate>
        <label>WhatsApp number *<input name="whatsapp" type="tel" inputmode="tel" placeholder="082 123 4567" required></label>
        <label>First name<input name="name" type="text" maxlength="40" placeholder="Optional"></label>
        <label>Region<select name="region"><option value="">Soweto or Roodepoort</option><option value="Soweto">Soweto</option><option value="Roodepoort">Roodepoort</option></select></label>
        <label>Suburb<select name="suburb"><option value="">Any suburb</option></select></label>
        <label>Kind of place<select name="propType"><option value="">Any kind</option>${options(opts.propertyTypes)}</select></label>
        <label>${isRent ? 'Highest rent a month (R)' : 'Highest price (R)'}<input name="maxPrice" type="number" min="0" inputmode="numeric" placeholder="Any"></label>
        <label class="alert-consent"><input name="consent" type="checkbox"> <span>${escapeHtml(ALERT_CONSENT)}</span></label>
        <button type="submit">Alert me on WhatsApp</button>
        <p class="alert-msg" role="status"></p>
      </form>
    </div>`;

  const form = el.querySelector('form');
  const region = form.elements.region, suburb = form.elements.suburb;
  const fillSuburbs = () => {
    const list = opts.suburbs[region.value] || [];
    suburb.innerHTML = '<option value="">Any suburb</option>' + options(list);
  };
  region.addEventListener('change', fillSuburbs);

  // Until the visitor touches the card, it follows the search they are doing.
  let touched = false;
  form.addEventListener('input', () => { touched = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.alert-msg');
    const btn = form.querySelector('button');
    const f = form.elements;
    msg.className = 'alert-msg';
    if (!f.consent.checked) { msg.textContent = 'Tick the box to agree to receive WhatsApp alerts.'; msg.classList.add('err'); return; }
    btn.disabled = true;
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: opts.type, whatsapp: f.whatsapp.value, name: f.name.value,
          region: f.region.value, suburb: f.suburb.value, propType: f.propType.value,
          maxPrice: f.maxPrice.value, consent: true, consentText: ALERT_CONSENT
        })
      });
      const data = await res.json();
      msg.textContent = data.message || (data.success ? 'Done.' : 'That did not work. Please try again.');
      msg.classList.add(data.success ? 'ok' : 'err');
      if (data.success) { f.whatsapp.value = ''; f.consent.checked = false; }
    } catch (err) {
      msg.textContent = 'That did not work. Check your connection and try again.';
      msg.classList.add('err');
    }
    btn.disabled = false;
  });

  return {
    // Copy the page's current filters into the card, unless the visitor has
    // already started filling it in themselves.
    syncFrom(filters) {
      if (touched) return;
      region.value = filters.region || '';
      fillSuburbs();
      suburb.value = filters.suburb || '';
      form.elements.propType.value = filters.propType || '';
      form.elements.maxPrice.value = filters.maxPrice || '';
    }
  };
}
