import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Its own preload, ahead of Testing Library's: `screen` binds to `document.body` when
// `@testing-library/dom` is first evaluated, so a DOM registered after that import leaves it
// bound to nothing.
GlobalRegistrator.register()
