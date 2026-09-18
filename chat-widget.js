/*
 * Digital Nomad Studio - website chat assistant.
 *
 * Two modes:
 *  - AI mode: talks to the Cloudflare Worker in chat-worker/ (window.DNS_CHAT.endpoint), which
 *    streams replies from Claude and delivers captured enquiries to the team.
 *  - Guided mode: a scripted set of questions that runs entirely in the browser and sends the
 *    enquiry through Web3Forms. Used when no endpoint is configured, when the Worker cannot be
 *    reached, or once a conversation reaches its turn cap.
 *
 * No dependencies. Styles are injected by this file so one script tag works on every page.
 * Any element with a data-open-chat attribute opens the assistant when clicked.
 * Optional: set window.DNS_CHAT.turnstileSiteKey to attach a Cloudflare Turnstile bot-check token
 * to every AI request (the Worker verifies it when its TURNSTILE_SECRET_KEY secret is set).
 */
(function () {
    'use strict';
    if (window.__dnsChatLoaded) { return; }
    window.__dnsChatLoaded = true;

    var cfg = Object.assign({ endpoint: '', web3formsKey: '', email: 'team@digitalnomadstudio.io', turnstileSiteKey: '' }, window.DNS_CHAT || {});
    var STORAGE_KEY = 'dnsChat.v2';
    var MAX_HISTORY = 24;      // 12 visitor turns, matching the Worker's cap
    var MAX_LEN = 1200;
    var WEB3FORMS_URL = 'https://api.web3forms.com/submit';
    var TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

    var GREETING = "Hi, I'm Marco, Digital Nomad Studio's AI assistant. I can help you describe a software or AI project for your business and pass it to the team. I can't help with anything else. What are you looking to build or automate?";
    var AI_STARTERS = ['Automate my admin', 'Prototype an AI idea', 'Build an app or SaaS product', 'Not sure yet'];
    var FALLBACK_NOTICE = "I'm in guided mode right now, so I'll ask a few quick questions and pass everything to the team.";
    var LIMIT_TEXT = "That's as far as I can take it here. Leave your details and the team will pick it up from here.";
    var LIMIT_NOTICE = 'Let me take your details so the team can follow up properly.';
    var LIMIT_NOTICE_OFF_TOPIC = "If you do have a project in mind, I can take your details for the team. Otherwise, that's all from me.";

    var FLOW = [
        {
            key: 'service',
            chips: ['AI automation', 'AI rapid prototype', 'Custom AI agent or assistant', 'AI features for my product', 'iOS app', 'SaaS or web product', 'Not sure yet'],
            placeholder: 'Or type your own answer',
            prompt: function () { return "I'll ask a few quick questions so the team knows exactly how to help. First - what are you looking for?"; }
        },
        {
            key: 'business',
            placeholder: 'e.g. Plumbing business, 8 staff',
            prompt: function () { return 'Great. Tell me a little about your business - what do you do, and roughly how big is the team?'; }
        },
        {
            key: 'problem',
            placeholder: 'What happens today?',
            prompt: function (a) {
                return a.service === 'Not sure yet'
                    ? "No problem. What's the biggest time sink or headache in the business right now?"
                    : "What's the problem you'd like to solve? Describe how it's handled today and what a good result would look like.";
            }
        },
        {
            key: 'timeline',
            chips: ['As soon as possible', 'Within 1-3 months', 'In 3-6 months', 'Just exploring'],
            placeholder: 'Or type a timeframe',
            prompt: function () { return 'When would you like to have something working?'; }
        },
        {
            key: 'budget',
            chips: ['Under $5k', '$5k - $15k', '$15k - $50k', '$50k+', 'Not sure yet'],
            placeholder: 'Or type a range',
            prompt: function () { return 'Do you have a budget range in mind? A rough idea helps us suggest the right starting point - it is fine to say not sure.'; }
        },
        {
            key: 'name',
            placeholder: 'Your name',
            prompt: function () { return 'Nearly done. What is your name?'; }
        },
        {
            key: 'email',
            placeholder: 'you@example.com',
            validate: isEmail,
            error: "That doesn't look like an email address - could you check it?",
            prompt: function (a) { return 'Thanks ' + firstName(a.name) + '. What is the best email to reach you on?'; }
        },
        {
            key: 'phone',
            chips: ['Skip'],
            optional: true,
            placeholder: 'Optional phone number',
            prompt: function () { return 'Optional: a phone number if you would prefer a call. Otherwise just press Skip.'; }
        }
    ];

    /* ---------------------------------------------------------------- helpers */
    function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()); }
    function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }
    function fresh() {
        return { mode: cfg.endpoint ? 'ai' : 'guided', messages: [], step: 0, answers: {}, sent: false, open: false, capped: false };
    }
    function load() {
        try {
            var raw = window.sessionStorage.getItem(STORAGE_KEY);
            if (!raw) { return null; }
            var s = JSON.parse(raw);
            if (!s || !Array.isArray(s.messages)) { return null; }
            if (s.mode === 'ai' && !cfg.endpoint) { s.mode = 'guided'; }
            return s;
        } catch (e) { return null; }
    }
    function save() {
        try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
    }

    /* ----------------------------------------------------------------- styles */
    var style = document.createElement('style');
    style.textContent = [
        '.dns-chat{position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom, 0px));z-index:1500;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-tap-highlight-color:transparent}',
        '.dns-chat *{box-sizing:border-box}',
        '.dns-chat button{touch-action:manipulation}',
        '.dns-chat-launcher{display:flex;align-items:center;gap:.55rem;background:#1a365d;color:#fff;border:0;border-radius:999px;padding:.9rem 1.3rem;font-family:inherit;font-size:1rem;font-weight:600;box-shadow:0 10px 25px rgba(26,54,93,.35);cursor:pointer;transition:transform .2s ease,background .2s ease}',
        '.dns-chat-launcher:hover{background:#2d5a87;transform:translateY(-2px)}',
        '.dns-chat-launcher:focus-visible,.dns-chat button:focus-visible{outline:3px solid #ff6b35;outline-offset:2px}',
        '.dns-chat-launcher svg{width:22px;height:22px;flex:none}',
        '.dns-chat.open .dns-chat-launcher{display:none}',
        'body:has(.nav-menu.active) .dns-chat-launcher{display:none}',
        '.dns-chat-panel{position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom, 0px));width:380px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 40px);background:#fff;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;border:1px solid #e2e8f0}',
        '.dns-chat-panel[hidden]{display:none}',
        '.dns-chat-header{display:flex;align-items:center;gap:.75rem;padding:.75rem .75rem .75rem 1rem;background:linear-gradient(135deg,#1a365d,#2d5a87);color:#fff}',
        '.dns-chat-avatar{width:40px;height:40px;border-radius:50%;background:#fff;padding:3px;object-fit:contain;flex:none;display:block}',
        '.dns-chat-heading{flex:1;display:flex;flex-direction:column;line-height:1.25;min-width:0}',
        '.dns-chat-heading strong{font-size:.95rem}',
        '.dns-chat-brand{font-size:.8rem;opacity:.85;font-weight:400}',
        '.dns-chat-heading .dns-chat-title{display:flex;align-items:baseline;gap:.4rem;flex-wrap:wrap}',
        '.dns-chat-status{font-size:.74rem;opacity:.85}',
        '.dns-chat-iconbtn{background:transparent;border:0;color:#fff;font-size:1.35rem;line-height:1;cursor:pointer;min-width:40px;min-height:40px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-family:inherit}',
        '.dns-chat-iconbtn:hover{background:rgba(255,255,255,.15)}',
        '.dns-chat-messages{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:1rem;display:flex;flex-direction:column;gap:.6rem;background:#f7fafc}',
        '.dns-chat-msg{max-width:86%;padding:.65rem .9rem;border-radius:14px;font-size:.95rem;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.dns-chat-msg.assistant{align-self:flex-start;background:#fff;color:#1a202c;border:1px solid #e2e8f0;border-bottom-left-radius:4px}',
        '.dns-chat-msg.user{align-self:flex-end;background:#1a365d;color:#fff;border-bottom-right-radius:4px}',
        '.dns-chat-msg ul{margin:.3rem 0 .3rem 1.15rem;padding:0;white-space:normal}',
        '.dns-chat-msg li{margin:.15rem 0}',
        '.dns-chat-backdrop{display:none;position:fixed;inset:0;background:#fff}',
        '.dns-chat-typing{display:inline-flex;gap:4px;align-items:center;height:1.2em}',
        '.dns-chat-typing i{width:6px;height:6px;border-radius:50%;background:#2d5a87;display:block;animation:dnsChatBlink 1.2s infinite}',
        '.dns-chat-typing i:nth-child(2){animation-delay:.2s}.dns-chat-typing i:nth-child(3){animation-delay:.4s}',
        '@keyframes dnsChatBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}',
        '.dns-chat-card{align-self:stretch;background:#fff;border:1px solid #e2e8f0;border-left:4px solid #ff6b35;border-radius:12px;padding:.9rem 1rem;font-size:.9rem;color:#1a202c}',
        '.dns-chat-card h4{margin:0 0 .5rem;font-size:.95rem;color:#1a365d}',
        '.dns-chat-card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.3rem .75rem}',
        '.dns-chat-card dt{color:#4a5568;font-weight:600}',
        '.dns-chat-card dd{margin:0;overflow-wrap:anywhere}',
        '.dns-chat-card-actions{display:flex;gap:.5rem;margin-top:.8rem;flex-wrap:wrap}',
        '.dns-chat-btn{border:0;border-radius:8px;padding:.6rem 1rem;min-height:40px;font-weight:600;font-size:.9rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;touch-action:manipulation}',
        '.dns-chat-btn.primary{background:#1a365d;color:#fff}.dns-chat-btn.primary:hover{background:#2d5a87}',
        '.dns-chat-btn.secondary{background:#fff;color:#1a365d;border:2px solid #1a365d}.dns-chat-btn.secondary:hover{background:#1a365d;color:#fff}',
        '.dns-chat-btn:disabled{opacity:.5;cursor:default}',
        '.dns-chat-chips{display:flex;flex-wrap:wrap;gap:.4rem;padding:0 1rem .6rem;background:#f7fafc}',
        '.dns-chat-chips:empty{display:none}',
        '.dns-chat-chip{background:#fff;border:1px solid #2d5a87;color:#1a365d;border-radius:999px;padding:.4rem .85rem;font-size:.85rem;cursor:pointer;font-family:inherit}',
        '.dns-chat-chip:hover{background:#1a365d;color:#fff}',
        '.dns-chat-turnstile{display:flex;justify-content:center;padding:0 1rem .5rem;background:#f7fafc}',
        '.dns-chat-turnstile:empty{display:none}',
        '.dns-chat-form{display:flex;align-items:flex-end;gap:.5rem;padding:.6rem .75rem;border-top:1px solid #e2e8f0;background:#fff}',
        '.dns-chat-input{flex:1;resize:none;border:1px solid #e2e8f0;border-radius:10px;padding:.6rem .75rem;font-family:inherit;font-size:.95rem;line-height:1.4;max-height:120px;color:#1a202c;background:#fff}',
        '.dns-chat-input:focus{outline:2px solid #2d5a87;border-color:transparent}',
        '.dns-chat-send{width:40px;height:40px;border-radius:50%;border:0;background:#ff6b35;color:#fff;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center}',
        '.dns-chat-send svg{width:18px;height:18px}',
        '.dns-chat-send:disabled{opacity:.5;cursor:default}',
        '.dns-chat-note{margin:0;padding:.35rem .9rem .6rem;font-size:.72rem;color:#4a5568;background:#fff;text-align:center}',
        '.dns-chat-sr{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
        '@media (max-width:600px){',
        '  .dns-chat-panel{top:0;left:0;right:0;bottom:auto;width:100%;max-width:100%;height:100vh;height:100dvh;max-height:none;border-radius:0;border:0}',
        '  .dns-chat-launcher-label{display:none}',
        '  .dns-chat-launcher{padding:.95rem}',
        '  .dns-chat-header{padding-top:calc(.75rem + env(safe-area-inset-top, 0px))}',
        '  .dns-chat-msg,.dns-chat-input{font-size:16px}',
        '  .dns-chat-iconbtn{min-width:44px;min-height:44px}',
        '  .dns-chat-send{width:44px;height:44px}',
        '  .dns-chat-chips{gap:.5rem}',
        '  .dns-chat-chip{min-height:44px;display:inline-flex;align-items:center;padding:.5rem 1rem;font-size:15px}',
        '  .dns-chat-note{padding-bottom:calc(.6rem + env(safe-area-inset-bottom, 0px))}',
        '  html.dns-chat-lock,html.dns-chat-lock body{overflow:hidden;background:#fff}',
        '  html.dns-chat-lock body > :not(.dns-chat){visibility:hidden}',
        '  .dns-chat.open .dns-chat-backdrop{display:block}',
        '}',
        '@media (prefers-reduced-motion:reduce){.dns-chat-launcher,.dns-chat-typing i{transition:none;animation:none}}'
    ].join('\n');
    document.head.appendChild(style);

    /* -------------------------------------------------------------------- DOM */
    var CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.6-4.8A8 8 0 1 1 21 12z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>';
    var SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';

    var root = el('div', 'dns-chat');
    root.innerHTML =
        '<button type="button" class="dns-chat-launcher" id="dnsChatLauncher" aria-label="Chat with Marco, our AI assistant" aria-expanded="false" aria-controls="dnsChatPanel">' +
            CHAT_ICON + '<span class="dns-chat-launcher-label">Chat with Marco</span>' +
        '</button>' +
        '<div class="dns-chat-backdrop" aria-hidden="true"></div>' +
        '<section class="dns-chat-panel" id="dnsChatPanel" role="dialog" aria-label="Marco, Digital Nomad Studio AI assistant" hidden>' +
            '<header class="dns-chat-header">' +
                '<img class="dns-chat-avatar" src="logo.png" alt="" width="40" height="40">' +
                '<div class="dns-chat-heading"><span class="dns-chat-title"><strong>Marco</strong><span class="dns-chat-brand">Digital Nomad Studio</span></span><span class="dns-chat-status" id="dnsChatStatus"></span></div>' +
                '<button type="button" class="dns-chat-iconbtn" id="dnsChatReset" aria-label="Start again" title="Start again">&#8635;</button>' +
                '<button type="button" class="dns-chat-iconbtn" id="dnsChatClose" aria-label="Close chat" title="Close">&times;</button>' +
            '</header>' +
            '<div class="dns-chat-messages" id="dnsChatMessages" aria-live="polite"></div>' +
            '<div class="dns-chat-chips" id="dnsChatChips"></div>' +
            '<div class="dns-chat-turnstile" id="dnsChatTurnstile"></div>' +
            '<form class="dns-chat-form" id="dnsChatForm" autocomplete="off">' +
                '<label class="dns-chat-sr" for="dnsChatInput">Your message</label>' +
                '<textarea id="dnsChatInput" class="dns-chat-input" rows="1" maxlength="' + MAX_LEN + '" placeholder="Message Marco..." autocapitalize="sentences" autocomplete="off" enterkeyhint="send"></textarea>' +
                '<button type="submit" class="dns-chat-send" id="dnsChatSend" aria-label="Send message">' + SEND_ICON + '</button>' +
            '</form>' +
            '<p class="dns-chat-note">For project enquiries only. We reply within two business days. Please don\'t share sensitive personal information.</p>' +
        '</section>';
    document.body.appendChild(root);

    var launcher = root.querySelector('#dnsChatLauncher');
    var panel = root.querySelector('#dnsChatPanel');
    var statusEl = root.querySelector('#dnsChatStatus');
    var messagesEl = root.querySelector('#dnsChatMessages');
    var chipsEl = root.querySelector('#dnsChatChips');
    var turnstileEl = root.querySelector('#dnsChatTurnstile');
    var form = root.querySelector('#dnsChatForm');
    var input = root.querySelector('#dnsChatInput');
    var sendBtn = root.querySelector('#dnsChatSend');
    var mobileQuery = window.matchMedia('(max-width: 600px)');

    var state = load() || fresh();
    var busy = false;

    /* -------------------------------------------------------------- rendering */
    function appendInline(parent, text) {
        String(text).split(/(\*\*[^*\n]+\*\*)/g).forEach(function (part) {
            if (/^\*\*[^*\n]+\*\*$/.test(part)) {
                parent.appendChild(el('strong', null, part.slice(2, -2)));
            } else if (part) {
                parent.appendChild(document.createTextNode(part));
            }
        });
    }
    // Assistant text may use **bold** and lines starting with "- ". Everything else is literal text.
    function renderRichText(node, text) {
        node.textContent = '';
        var list = null;
        String(text || '').split('\n').forEach(function (line, i) {
            var item = /^\s*[-*]\s+(.*)$/.exec(line);
            if (item) {
                if (!list) { list = el('ul'); node.appendChild(list); }
                var li = el('li');
                appendInline(li, item[1]);
                list.appendChild(li);
                return;
            }
            list = null;
            if (i > 0 && node.lastChild && node.lastChild.nodeName !== 'UL') { node.appendChild(document.createTextNode('\n')); }
            appendInline(node, line);
        });
    }
    function renderMessage(m) {
        var node;
        if (m.card) {
            node = renderCard(m);
        } else if (m.role === 'assistant') {
            node = el('div', 'dns-chat-msg assistant');
            renderRichText(node, m.text);
        } else {
            node = el('div', 'dns-chat-msg ' + m.role, m.text);
        }
        messagesEl.appendChild(node);
        return node;
    }
    function renderCard(m) {
        var card = el('div', 'dns-chat-card');
        var a = state.answers;
        if (m.card === 'summary') {
            card.appendChild(el('h4', null, 'Your enquiry'));
            var dl = el('dl');
            [['Looking for', a.service], ['Business', a.business], ['Problem', a.problem], ['Timeline', a.timeline], ['Budget', a.budget], ['Name', a.name], ['Email', a.email], ['Phone', a.phone || 'Not provided']].forEach(function (row) {
                dl.appendChild(el('dt', null, row[0]));
                dl.appendChild(el('dd', null, row[1] || '-'));
            });
            card.appendChild(dl);
            var actions = el('div', 'dns-chat-card-actions');
            var send = el('button', 'dns-chat-btn primary', state.sent ? 'Sent' : 'Send to the team');
            send.type = 'button';
            send.disabled = !!state.sent;
            send.addEventListener('click', function () { submitLead(send); });
            var again = el('button', 'dns-chat-btn secondary', 'Start again');
            again.type = 'button';
            again.addEventListener('click', reset);
            actions.appendChild(send);
            actions.appendChild(again);
            card.appendChild(actions);
        } else if (m.card === 'ai-summary') {
            var d = m.data || {};
            card.appendChild(el('h4', null, 'Your enquiry'));
            var dl2 = el('dl');
            [['Looking for', d.service_type], ['Business', d.business], ['Industry', d.industry], ['Problem', d.problem], ['Timeline', d.timeline], ['Budget', d.budget], ['Name', d.name], ['Email', d.email], ['Phone', d.phone]].forEach(function (row) {
                var optional = ['Industry', 'Timeline', 'Budget', 'Phone'].indexOf(row[0]) >= 0;
                if (!row[1] || (optional && /^not (provided|sure|given)/i.test(row[1]))) { return; }
                dl2.appendChild(el('dt', null, row[0]));
                dl2.appendChild(el('dd', null, row[1]));
            });
            card.appendChild(dl2);
            var actions3 = el('div', 'dns-chat-card-actions');
            var sendNow = el('button', 'dns-chat-btn primary', state.sent ? 'Sent' : 'Send to the team');
            sendNow.type = 'button';
            sendNow.disabled = !!state.sent;
            sendNow.addEventListener('click', function () { if (!state.sent && !busy) { handleInput('Yes, please send it to the team.'); } });
            var change = el('button', 'dns-chat-btn secondary', 'Change something');
            change.type = 'button';
            change.addEventListener('click', function () { input.placeholder = 'Tell me what to change...'; input.focus(); });
            actions3.appendChild(sendNow);
            actions3.appendChild(change);
            card.appendChild(actions3);
        } else if (m.card === 'sent') {
            card.appendChild(el('h4', null, 'Sent to the team'));
            card.appendChild(el('p', null, m.text));
        } else if (m.card === 'mailto') {
            card.appendChild(el('h4', null, "That didn't send"));
            card.appendChild(el('p', null, m.text));
            var actions2 = el('div', 'dns-chat-card-actions');
            var link = el('a', 'dns-chat-btn primary', 'Email these details');
            link.href = mailtoHref();
            actions2.appendChild(link);
            card.appendChild(actions2);
        }
        return card;
    }
    function renderAll() {
        messagesEl.innerHTML = '';
        state.messages.forEach(renderMessage);
        renderChips();
        statusEl.textContent = state.mode === 'ai' ? 'AI assistant' : 'Guided enquiry';
        input.placeholder = currentPlaceholder();
        scrollToEnd();
    }
    function currentChips() {
        if (busy) { return []; }
        if (state.mode === 'guided') {
            var step = FLOW[state.step];
            return step && step.chips ? step.chips : [];
        }
        var hasUser = state.messages.some(function (m) { return m.role === 'user'; });
        return hasUser ? [] : AI_STARTERS;
    }
    function currentPlaceholder() {
        if (state.mode === 'guided') {
            var step = FLOW[state.step];
            if (!step) { return state.sent ? 'Anything else? Email us at ' + cfg.email : 'Press "Send to the team" above'; }
            return step.placeholder || 'Type your answer...';
        }
        return 'Message Marco...';
    }
    function renderChips() {
        chipsEl.innerHTML = '';
        currentChips().forEach(function (label) {
            var chip = el('button', 'dns-chat-chip', label);
            chip.type = 'button';
            chip.addEventListener('click', function () { handleInput(label); });
            chipsEl.appendChild(chip);
        });
        input.placeholder = currentPlaceholder();
    }
    function scrollToEnd() { messagesEl.scrollTop = messagesEl.scrollHeight; }
    function addMessage(role, text, extra) {
        var m = Object.assign({ role: role, text: text }, extra || {});
        state.messages.push(m);
        var node = renderMessage(m);
        scrollToEnd();
        return node;
    }
    function setBusy(v) {
        busy = v;
        sendBtn.disabled = v;
        renderChips();
    }

    /* -------------------------------------------------------------- guided flow */
    function askStep() {
        var step = FLOW[state.step];
        if (!step) {
            addMessage('assistant', "Here's what I'll send to the team. Happy with it?", { local: true, card: 'summary' });
            return;
        }
        addMessage('assistant', step.prompt(state.answers), { local: true });
    }
    function startGuidedCapture(notice) {
        state.mode = 'guided';
        state.step = 0;
        state.answers = {};
        statusEl.textContent = 'Guided enquiry';
        addMessage('assistant', notice, { local: true });
        askStep();
    }
    function handleGuidedInput(text) {
        var step = FLOW[state.step];
        if (/^marco[!.?]*$/i.test(text.trim())) {
            addMessage('user', text, { local: true });
            addMessage('assistant', 'Polo! Now, back to your project.', { local: true });
            if (step) { addMessage('assistant', step.prompt(state.answers), { local: true }); }
            return;
        }
        if (!step) {
            addMessage('user', text, { local: true });
            addMessage('assistant', state.sent
                ? "Your enquiry has already gone through - we'll be in touch soon. For anything else, email " + cfg.email + '.'
                : 'Use "Send to the team" above when you are happy with the summary, or "Start again" to change your answers.', { local: true });
            return;
        }
        var value = text;
        if (step.optional && /^skip$/i.test(text.trim())) { value = ''; }
        addMessage('user', text, { local: true });
        if (value && step.validate && !step.validate(value)) {
            addMessage('assistant', step.error, { local: true });
            return;
        }
        state.answers[step.key] = value.trim();
        state.step += 1;
        askStep();
    }
    function mailtoHref() {
        var a = state.answers;
        var body = ['Looking for: ' + (a.service || ''), 'Business: ' + (a.business || ''), 'Problem: ' + (a.problem || ''), 'Timeline: ' + (a.timeline || ''), 'Budget: ' + (a.budget || ''), 'Name: ' + (a.name || ''), 'Email: ' + (a.email || ''), 'Phone: ' + (a.phone || '')].join('\n');
        return 'mailto:' + cfg.email + '?subject=' + encodeURIComponent('Project enquiry from the website') + '&body=' + encodeURIComponent(body);
    }
    function submitLead(button) {
        if (state.sent || busy) { return; }
        var a = state.answers;
        var fd = new FormData();
        fd.append('access_key', cfg.web3formsKey);
        fd.append('subject', 'New Chat Enquiry - ' + (a.service || 'Website chat'));
        fd.append('from_name', 'Website chat assistant');
        fd.append('name', a.name || '');
        fd.append('email', a.email || '');
        fd.append('phone', a.phone || '');
        fd.append('service', a.service || '');
        fd.append('business', a.business || '');
        fd.append('problem', a.problem || '');
        fd.append('timeline', a.timeline || '');
        fd.append('budget', a.budget || '');
        fd.append('page', window.location.href);
        button.disabled = true;
        button.textContent = 'Sending...';
        setBusy(true);
        fetch(WEB3FORMS_URL, { method: 'POST', body: fd, headers: { Accept: 'application/json' } })
            .then(function (res) {
                return res.json().then(function (data) {
                    if (!res.ok || !data.success) { throw new Error(data.message || 'Send failed'); }
                });
            })
            .then(function () {
                state.sent = true;
                button.textContent = 'Sent';
                addMessage('assistant', 'Thanks ' + firstName(a.name) + "! Your enquiry is on its way and we'll reply within two business days. If anything else comes to mind, email us at " + cfg.email + '.', { local: true, card: 'sent' });
            })
            .catch(function () {
                button.disabled = false;
                button.textContent = 'Try again';
                addMessage('assistant', 'Sorry - we could not send that just now. You can try again, or email the details to ' + cfg.email + ' and we will pick it up from there.', { local: true, card: 'mailto' });
            })
            .then(function () { setBusy(false); save(); });
    }

    /* ------------------------------------------------------------ bot check */
    var ts = { loading: null, widgetId: null, onToken: null };
    function loadTurnstile() {
        if (ts.loading) { return ts.loading; }
        ts.loading = new Promise(function (resolve, reject) {
            if (window.turnstile) { resolve(window.turnstile); return; }
            var script = document.createElement('script');
            script.src = TURNSTILE_SRC;
            script.async = true;
            script.defer = true;
            var timer = setTimeout(function () { reject(new Error('turnstile timeout')); }, 15000);
            script.onload = function () { clearTimeout(timer); resolve(window.turnstile); };
            script.onerror = function () { clearTimeout(timer); reject(new Error('turnstile failed to load')); };
            document.head.appendChild(script);
        });
        ts.loading.catch(function () { ts.loading = null; });
        return ts.loading;
    }
    function getTurnstileToken() {
        if (!cfg.turnstileSiteKey) { return Promise.resolve(''); }
        return loadTurnstile().then(function (turnstile) {
            if (!turnstile) { throw new Error('turnstile unavailable'); }
            return new Promise(function (resolve, reject) {
                var finished = false;
                var timer = setTimeout(function () { finish(new Error('turnstile timeout')); }, 20000);
                function finish(err, token) {
                    if (finished) { return; }
                    finished = true;
                    clearTimeout(timer);
                    ts.onToken = null;
                    if (err) { reject(err); } else { resolve(token); }
                }
                ts.onToken = finish;
                if (ts.widgetId === null) {
                    ts.widgetId = turnstile.render(turnstileEl, {
                        sitekey: cfg.turnstileSiteKey,
                        execution: 'execute',
                        appearance: 'interaction-only',
                        callback: function (token) { if (ts.onToken) { ts.onToken(null, token); } },
                        'error-callback': function (code) { if (ts.onToken) { ts.onToken(new Error('turnstile error ' + code)); } return true; },
                        'expired-callback': function () { if (ts.onToken) { ts.onToken(new Error('turnstile expired')); } }
                    });
                } else {
                    turnstile.reset(ts.widgetId);
                }
                turnstile.execute(ts.widgetId);
            });
        });
    }

    /* ----------------------------------------------------------------- AI mode */
    function historyForAI() {
        return state.messages
            .filter(function (m) { return !m.local && !m.card && m.text; })
            .map(function (m) { return { role: m.role, content: m.text.slice(0, MAX_LEN) }; })
            .slice(-MAX_HISTORY);
    }
    function handleAIInput(text) {
        addMessage('user', text);
        var history = historyForAI();
        if (history.length >= MAX_HISTORY) {
            state.capped = true;
            addMessage('assistant', LIMIT_TEXT, { local: true });
            startGuidedCapture(LIMIT_NOTICE);
            return;
        }
        setBusy(true);
        var bubble = null;
        function newBubble() {
            bubble = el('div', 'dns-chat-msg assistant');
            bubble.innerHTML = '<span class="dns-chat-typing" aria-label="Assistant is typing"><i></i><i></i><i></i></span>';
            messagesEl.appendChild(bubble);
            scrollToEnd();
        }
        newBubble();
        var got = '';
        var leadSent = false;
        var capped = false;
        var sawSummary = false;
        var limitReason = '';
        function flushBubble() {
            bubble.remove();
            if (got) { addMessage('assistant', got); got = ''; }
        }

        function handleEvent(evt) {
            if (evt.type === 'text' && typeof evt.delta === 'string') {
                got += evt.delta;
                renderRichText(bubble, got);
                scrollToEnd();
            } else if (evt.type === 'summary' && evt.data && typeof evt.data === 'object') {
                sawSummary = true;
                flushBubble();
                addMessage('assistant', '', { local: true, card: 'ai-summary', data: evt.data });
                newBubble();
            } else if (evt.type === 'lead') {
                leadSent = true;
            } else if (evt.type === 'limit') {
                capped = true;
                limitReason = typeof evt.reason === 'string' ? evt.reason : '';
            } else if (evt.type === 'error') {
                throw new Error(evt.message || 'assistant error');
            }
        }
        function handleChunk(chunk) {
            chunk.split('\n').forEach(function (line) {
                if (line.indexOf('data:') !== 0) { return; }
                var payload = line.slice(5).trim();
                if (!payload) { return; }
                var evt;
                try { evt = JSON.parse(payload); } catch (e) { return; }
                handleEvent(evt);
            });
        }
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, 60000) : null;

        getTurnstileToken().then(function (token) {
            var payload = { messages: history, page: window.location.pathname };
            if (token) { payload.turnstileToken = token; }
            return fetch(cfg.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller ? controller.signal : undefined
            });
        }).then(function (res) {
            if (!res.ok || !res.body) { throw new Error('HTTP ' + res.status); }
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        if (buffer.trim()) { handleChunk(buffer); }
                        return;
                    }
                    buffer += decoder.decode(r.value, { stream: true });
                    var idx;
                    while ((idx = buffer.indexOf('\n\n')) >= 0) {
                        handleChunk(buffer.slice(0, idx));
                        buffer = buffer.slice(idx + 2);
                    }
                    return pump();
                });
            }
            return pump();
        }).then(function () {
            if (!got && !sawSummary) { throw new Error('empty reply'); }
            flushBubble();
            if (leadSent) {
                state.sent = true;
                addMessage('assistant', "Your details are with the team now. We'll reply within two business days.", { local: true, card: 'sent' });
                renderAll();
            }
            if (capped && !leadSent) {
                state.capped = true;
                startGuidedCapture(limitReason === 'off_topic' ? LIMIT_NOTICE_OFF_TOPIC : LIMIT_NOTICE);
            }
        }).catch(function () {
            var hadText = !!got || sawSummary;
            flushBubble();
            if (hadText) {
                addMessage('assistant', 'Sorry, the connection dropped part-way through. Please send that again.', { local: true });
            } else {
                startGuidedCapture(FALLBACK_NOTICE);
            }
        }).then(function () {
            if (timer) { clearTimeout(timer); }
            setBusy(false);
            save();
        });
    }

    /* --------------------------------------------------------------- phones */
    // The site's own nav script resets body.style.overflow on every click, so the lock is a class
    // on <html> (styled under the phone media query) rather than an inline style.
    function lockScroll() { document.documentElement.classList.add('dns-chat-lock'); }
    function unlockScroll() { document.documentElement.classList.remove('dns-chat-lock'); }
    // Keep the panel aligned with the visible part of the screen while the on-screen keyboard is up.
    function fitToViewport() {
        if (panel.hidden || !mobileQuery.matches || !window.visualViewport) {
            panel.style.height = '';
            panel.style.top = '';
            return;
        }
        var vv = window.visualViewport;
        panel.style.top = Math.max(0, Math.round(vv.offsetTop)) + 'px';
        panel.style.height = Math.round(vv.height) + 'px';
        scrollToEnd();
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', fitToViewport);
        window.visualViewport.addEventListener('scroll', fitToViewport);
    }
    window.addEventListener('resize', fitToViewport);

    /* ---------------------------------------------------------------- control */
    function handleInput(text) {
        text = String(text || '').trim().slice(0, MAX_LEN);
        if (!text || busy) { return; }
        input.value = '';
        autosize();
        if (state.mode === 'ai') { handleAIInput(text); } else { handleGuidedInput(text); }
        save();
        renderChips();
    }
    function start() {
        if (state.messages.length) { return; }
        addMessage('assistant', GREETING, { local: true });
        if (state.mode === 'guided') { askStep(); }
        save();
        renderChips();
    }
    function open(focus) {
        root.classList.add('open');
        panel.hidden = false;
        launcher.setAttribute('aria-expanded', 'true');
        state.open = true;
        lockScroll();
        fitToViewport();
        renderAll();
        start();
        if (focus !== false && !mobileQuery.matches) { input.focus(); }
    }
    function close() {
        root.classList.remove('open');
        panel.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
        state.open = false;
        unlockScroll();
        fitToViewport();
        save();
        launcher.focus();
    }
    function reset() {
        state = fresh();
        state.open = true;
        save();
        renderAll();
        start();
        if (!mobileQuery.matches) { input.focus(); }
    }
    function autosize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    launcher.addEventListener('click', function () { open(); });
    root.querySelector('#dnsChatClose').addEventListener('click', close);
    root.querySelector('#dnsChatReset').addEventListener('click', reset);
    form.addEventListener('submit', function (e) { e.preventDefault(); handleInput(input.value); });
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleInput(input.value); }
    });
    input.addEventListener('input', autosize);
    input.addEventListener('focus', function () { setTimeout(fitToViewport, 300); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { close(); }
    });
    document.addEventListener('click', function (e) {
        var trigger = e.target.closest ? e.target.closest('[data-open-chat]') : null;
        if (trigger) { e.preventDefault(); open(); }
    });

    if (state.open && state.messages.length) { open(false); }
})();
