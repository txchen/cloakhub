# CloakBrowser feedback tracking

Submitted with user authorization. Existing threads were checked before posting. Each new comment and issue was read back after submission. No raw credentials, IPs or Visitor IDs were attached.

| Finding | Destination | Scope |
|---|---|---|
| WebGL/Vulkan initialization failure on 155/156 | [#636](https://github.com/CloakHQ/CloakBrowser/issues/636) | Previously submitted. Includes headed graphics flags and headless failure. |
| macOS headless tampering on 156; VM flags | [#370 comment](https://github.com/CloakHQ/CloakBrowser/issues/370#issuecomment-6581842829) | Same-day 155/156 results; GPU failure remains a confounder. |
| Windows persona tampering | [#541 comment](https://github.com/CloakHQ/CloakBrowser/issues/541#issuecomment-6581843657) | Explicitly notes incomplete Windows fonts and missing supported-baseline test. |
| IPHey non-completion and historical font-query delay | [#524 comment](https://github.com/CloakHQ/CloakBrowser/issues/524#issuecomment-6581844453) | Separates October font/error evidence from unexplained November failures. |
| Different seeds linked to one visitor; mode-dependent Canvas | [#553 comment](https://github.com/CloakHQ/CloakBrowser/issues/553#issuecomment-6581845296) | Historical observation, shared exit and service history acknowledged; no uniqueness guarantee asserted. |
| Incolumitas WEBDRIVER result | [#135 comment](https://github.com/CloakHQ/CloakBrowser/issues/135#issuecomment-6581846123) | Current-version observations only; descriptor hypothesis unverified. |
| Rebrowser main-world/exposeFunction detection | [#176 comment](https://github.com/CloakHQ/CloakBrowser/issues/176#issuecomment-6581864336) | Deliberately triggered operations; acknowledges documented binding limitations. |
| Duplicate en-US in Linux navigator.languages | [#637](https://github.com/CloakHQ/CloakBrowser/issues/637) | New issue after duplicate search; manager versus binary attribution unresolved. |

No separate issue was opened for ML score fluctuations, VPN/OS mismatch alone, CreepJS's aggregate percentages, or font counts alone. These are observations or possible expected behavior, not independently established defects. Relevant observations are included in the existing threads where useful.

The comparison baseline is 155.0.8059.39.1, not stable 155.0.8059.39.2. None of the submissions claims to have tested .2.
