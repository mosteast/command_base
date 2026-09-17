"use strict";

const GITIGNORE_TEMPLATE = `# Scratch
/tmp/
/log/
/logs/
*.log

# Node
node_modules/
/build/
/dist/
/coverage/
/.next/
/.nuxt/
/.turbo/
/.vercel/
/.cache/
/.parcel-cache/
.nyc_output/
*.tsbuildinfo
.eslintcache
.npm
.yarn-integrity
.pnp.*
.yarn/cache
.yarn/unplugged
.yarn/build-state.yml
.yarn/install-state.gz
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*
*.tgz

# Secrets
.env
.env.*
!.env.example

# macOS / iCloud Drive
.DS_Store
._*
*.icloud
Icon?

# Windows
Thumbs.db
Desktop.ini

# Editors / IDEs
.idea/
.vscode/
.cursor/
.obsidian/
*.swp
*~
`;

const GITATTRIBUTES_TEMPLATE = `# Normalize text to LF. Binary / LFS rules below override this with -text.
* text=auto eol=lf

*.md text eol=lf
*.txt text eol=lf

# Raster and document binaries
*.pdf filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.webp filter=lfs diff=lfs merge=lfs -text
*.gif filter=lfs diff=lfs merge=lfs -text
*.tif filter=lfs diff=lfs merge=lfs -text
*.tiff filter=lfs diff=lfs merge=lfs -text
*.heic filter=lfs diff=lfs merge=lfs -text
*.ico filter=lfs diff=lfs merge=lfs -text

# Vector and design sources
*.svg filter=lfs diff=lfs merge=lfs -text
*.ai filter=lfs diff=lfs merge=lfs -text
*.sketch filter=lfs diff=lfs merge=lfs -text
*.psd filter=lfs diff=lfs merge=lfs -text

# Audio / video
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.wav filter=lfs diff=lfs merge=lfs -text
*.aac filter=lfs diff=lfs merge=lfs -text
*.m4a filter=lfs diff=lfs merge=lfs -text
*.mp4 filter=lfs diff=lfs merge=lfs -text
*.mov filter=lfs diff=lfs merge=lfs -text
*.webm filter=lfs diff=lfs merge=lfs -text
`;

module.exports = {
  GITIGNORE_TEMPLATE,
  GITATTRIBUTES_TEMPLATE,
};
