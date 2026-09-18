/*
 * Digital Nomad Studio - Google Ads conversion tracking and Google Analytics.
 *
 * Fill in the IDs below. With every ID empty this file loads nothing and does nothing.
 *   googleAdsId   Google Ads > Goals > Conversions > tag setup, looks like "AW-1234567890"
 *   ga4Id         Google Analytics > Admin > Data streams > Web, looks like "G-XXXXXXXXXX"
 *   conversions   one label per conversion action, looks like "AW-1234567890/AbCdEfGhIjKlMnOp"
 *                 (conversion actions created with "Create manually using code")
 *   events        one event name per conversion action created "from website events", looks like
 *                 "ads_conversion_Submit_lead_form_1"; fired without send_to so it reaches the Ads
 *                 tag and Analytics alike
 *
 * The site calls window.dnsTrack("form") when the project form is delivered and
 * window.dnsTrack("chat") when Marco delivers an enquiry. Clicks on email and App Store links
 * are tracked automatically. Each call sends a Google Ads conversion (when a label exists) and a
 * Google Analytics event (when ga4Id is set).
 */
(function () {
    'use strict';
    var CONFIG = {
        googleAdsId: 'AW-18458647532',
        ga4Id: 'G-M7QPHS152N',
        conversions: {
            form: '',       // Project form enquiry
            chat: '',       // Marco chat enquiry
            email: '',      // Email link click
            appstore: ''    // App Store click
        },
        events: {
            form: 'ads_conversion_Submit_lead_form_1',   // Google Ads conversion (source: Analytics property 554805907)
            chat: 'ads_conversion_Submit_lead_form_1',   // Marco enquiries count as the same lead-form conversion
            email: '',
            appstore: ''
        }
    };
    var GA4_EVENTS = { form: 'generate_lead', chat: 'generate_lead', email: 'contact_click', appstore: 'app_store_click' };

    var ids = [CONFIG.googleAdsId, CONFIG.ga4Id].filter(Boolean);
    var enabled = ids.length > 0;

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    if (!window.gtag) { window.gtag = gtag; }

    if (enabled) {
        var loader = document.createElement('script');
        loader.async = true;
        loader.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ids[0]);
        document.head.appendChild(loader);
        gtag('js', new Date());
        ids.forEach(function (id) { gtag('config', id); });
    }

    window.dnsTrack = function (name, params) {
        if (!enabled) { return false; }
        var fired = false;
        var label = CONFIG.conversions[name];
        if (CONFIG.googleAdsId && label) {
            gtag('event', 'conversion', Object.assign({ send_to: label, transport_type: 'beacon' }, params || {}));
            fired = true;
        }
        var eventName = CONFIG.events[name];
        if (eventName) {
            gtag('event', eventName, Object.assign({ transport_type: 'beacon', lead_source: name }, params || {}));
            fired = true;
        }
        if (CONFIG.ga4Id && GA4_EVENTS[name]) {
            gtag('event', GA4_EVENTS[name], Object.assign({ send_to: CONFIG.ga4Id, transport_type: 'beacon', lead_source: name }, params || {}));
            fired = true;
        }
        return fired;
    };

    // Email and App Store links, tracked in the capture phase so navigation is never delayed or blocked.
    document.addEventListener('click', function (e) {
        var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!link) { return; }
        var href = link.getAttribute('href') || '';
        if (/^mailto:/i.test(href)) {
            window.dnsTrack('email', { link_url: href });
        } else if (/^https?:\/\/apps\.apple\.com\//i.test(href)) {
            window.dnsTrack('appstore', { link_url: href });
        }
    }, true);
})();
