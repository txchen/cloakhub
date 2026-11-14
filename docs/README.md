# CloakHub documentation

## Guides (current)

- [Automation API](api.md): profiles, lifecycle, CDP tokens, events and viewer settings.
- [Development and tests](development.md): Go layout, running from source, test suites, releases.
- [Mac fonts and image builds](private-macos.md): bundled fonts, building the image, private font images.
- [Reusable browser version evaluation suite](browser-evaluation.md): comparing CloakBrowser builds in a pinned lab.
- [CloakBrowser feedback tracking](cloakbrowser-feedback-tracking.md): upstream issues CloakHub works around.
- Client setup lives with the browser skill: [setup and troubleshooting](../skills/cloakhub-browser/references/setup.md).

## Decisions

[`adr/`](adr/) records architecture decisions in order. Later ADRs supersede earlier
ones where they say so; notably [0035](adr/0035-xvfb-and-voxl-display-runtime.md)
(Xvfb and voxl replace KasmVNC) and [0036](adr/0036-go-hub-runtime.md) (the Go Hub
replaces Bun).

## Research and historical records

These are dated measurements and analyses. They describe the builds, images and
tooling of their time (for example KasmVNC viewers, the separate `cloakhub_free` image,
license-keyed images, or the Bun runtime) and are kept unchanged as evidence; raw data
is under [`evidence/`](evidence/).

- [CloakHub v1 PRD](cloakhub-v1-prd.md): the original product requirements.
- [CloakBrowser 151 deployment](cloakbrowser-151.md), including the license-key pooling of earlier
  releases, and [152 preview vs 151 stable](browser-channel-comparison.md).
- [CloakBrowser 156 patch validation](cloakbrowser-156-patch-validation.md): the license-free 156 build the image bakes.
- Anti-detection comparisons: [preview 154 57.1 vs 57.2](preview-154-57.1-vs-57.2-antidetection.md),
  [preview 155](preview-155-antidetection.md), [preview 156](preview-156-antidetection.md),
  [free 0.8.0 vs 0.9.0](free-080-vs-090-antidetection.md),
  [152 vs 156 follow-up](152-vs-156-followup.md), [152 vs 156 flags isolated](152-vs-156-flags-isolated.md),
  [156 configuration isolation](156-configuration-isolation.md),
  [156 Windows persona](156-windows-persona.md), [156 Windows fonts](156-windows-fonts.md),
  [identity diagnosis](identity-diagnosis-20261001.md),
  [Lightpanda 1.0 vs CloakBrowser](lightpanda-1.0-vs-cloakbrowser.md),
  [Obscura v0.2.6 vs CloakBrowser 156](obscura-vs-cloakbrowser.md) ([source review](obscura-source-review.md)).
- Rendering: [GPU-less rendering evaluation](gpu-less-rendering-evaluation.md),
  [WebGL issue draft](cloakbrowser-webgl-issue-draft.md),
  [background tabs and focus emulation](background-tabs-evaluation.md).
- [Scoped adapters and disconnect recovery](adapter-recovery-evaluation.md): v2 evidence contract, document write gate and real-agent boundary trials.
- [Durable checkpoints and cold-agent recovery](checkpoint-recovery-evaluation.md): executable checkpoint state machine and fresh-agent fault tests.
- [Paired skill evaluation with real agents](skill-agent-evaluation.md): frozen old/new skill snapshots, independent business scoring and fault recovery.
- Agent tooling comparisons: [Browser Use 1.0 analysis](browser-use-1-analysis.md),
  [Browser Use 1.0 comparison](browser-use-1-comparison.md),
  [Pi browser comparison](pi-browser-comparison.md), [OpenCode Browse](opencode-browse-analysis.md).
