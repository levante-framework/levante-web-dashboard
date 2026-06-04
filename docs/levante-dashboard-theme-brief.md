# LEVANTE Static Dashboard Theme Brief

## Goal
Refactor the LEVANTE dashboard static site into a research operations interface that feels like modern mission control: calm, readable, structured, and credible for academic/research use.

## Tone
- Modern, easy on the eyes, light and calm
- NASA mission control meets research operations console (light "daylight" instrument panel)
- Serious and data-centric, not sci-fi cosplay
- Calm, focused, and dense only where density adds value

## Avoid
- LCARS styling
- Pure white (#FFFFFF) or pure black (#000000)
- Neon glows, hologram/HUD gimmicks
- Tiny text
- Many saturated colors across widgets
- Over-designed “tech” gradients
- Layout instability from panels jumping around between pages

## Visual direction
- Background: soft cool gray / paper, not pure white
- Surfaces: layered light neutrals (near-white cards) with subtle separation
- Primary accent: cyan for active telemetry + selected states (dark enough for AA on light)
- Secondary accent: restrained amber or red for alerts or exceptional states only
- Text: dark slate and cool grays, never pure black on pure white
- Borders: subtle alpha borders, minimal hard separators
- Motion: minimal; avoid distracting animation

## Information architecture
The static site is still a “dashboard”:
- Stable top command bar for context and global actions
- Stable left (or top) navigation for sections
- Main content area with clear operational zones
- Focus sections:
  - participant/study health
  - assignment completion
  - recent activity / change log
  - maps / geographic coverage (if present)
  - chart summaries
  - alerts / action queues

## Accessibility requirements
- Target WCAG 2.1 AA contrast for text and UI controls
- Do not rely on color alone for meaning (charts, badges, status)
- Body text minimum 16px
- Controls minimum 44px tap height where appropriate
- Visible keyboard focus states
- Respect prefers-reduced-motion

## Chart / visualization guidance
(If charts or infographics are present)
- Use a restrained palette
- Keep a consistent semantic mapping for success / warning / error / active
- Prefer clear labels and concise captions
- Remove visual chart junk (excess gridlines, heavy shadows)

## Success criteria
- Site feels cohesive and easier to scan
- Navigation is spatially predictable
- Visuals look part of a single system
- UI feels research-grade, not like a generic admin template