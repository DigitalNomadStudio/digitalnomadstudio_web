// Digital Nomad Studio - chat assistant configuration.
//
// endpoint:     URL of the deployed Cloudflare Worker from chat-worker/ (for example
//               "https://dns-chat.<your-subdomain>.workers.dev"). Leave it empty to run
//               the built-in guided questions only, with no AI calls.
// web3formsKey: Web3Forms access key used by the guided flow to deliver enquiries.
//               This is a public key (the same one used by submit-idea.html).
// email:        Address shown to visitors as a fallback.
window.DNS_CHAT = {
    endpoint: "https://dns-chat.backwhen.workers.dev",
    web3formsKey: "fd336c42-816b-4a5b-a2fc-e6e970494682",
    email: "team@digitalnomadstudio.io"
};
