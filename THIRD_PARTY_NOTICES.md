# Third-party notices

Postora Browser Agent ships the third-party code listed below. Each notice names
the project, its licence, and the licence text.

## pi-ai — `@earendil-works/pi-ai`

- **Package:** `@earendil-works/pi-ai`
- **Version:** 1.1.0
- **Author:** Mario Zechner
- **Licence:** MIT
- **Repository:** <https://github.com/earendil-works/pi> (`packages/ai`)

The file `src/vendor/pi-oauth.js` is a bundle of parts of this package, built
by `npm run build:vendor` and committed, so the extension loads unpacked with
no build step. It is generated — do not edit it by hand. The bundle is used
for the account sign-in and the token refresh only; no model call goes through
it.

### Licence text

```
Copyright (c) Mario Zechner

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

Other services the extension talks to (the AI providers you choose, Google Drive
for the optional backup, and Formspree for feedback) are not bundled: their
terms and privacy policies apply to the data sent to them.
