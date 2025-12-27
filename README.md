# 1f2c - 1 Folder 2 Computers

A peer-to-peer file synchronization tool that enables direct folder transfer between two computers without intermediate servers.

## Features

- **Direct P2P Transfer**: Files transfer directly between computers using WebRTC
- **Efficient Sync**: Only missing or corrupted blocks are transferred
- **Secure**: End-to-end encrypted via WebRTC DataChannels
- **Simple**: 8-character share code to connect
- **Smart Caching**: Reuse previous folder indexes to save time
- **Progress Tracking**: Real-time transfer speed, ETA, and status
- **Integrity Verification**: SHA-256 hashing ensures data accuracy

## Quick Start

### Option 1: Run Locally

1. **Start a local web server**:
   ```bash
   # Using Python
   python -m http.server 8000
   
   # Or using Node.js
   npx http-server -p 8000
   ```

2. **Open in Chrome**:
   ```
   http://localhost:8000
   ```

3. **On both computers**:
   - Computer 1: Select "Sender", choose folder, get share code
   - Computer 2: Select "Receiver", enter share code, choose destination

### Option 2: Deploy to GitHub Pages

1. **Create GitHub repository**:
   - Go to https://github.com
   - Create new repo named `1f2c`

2. **Enable GitHub Pages**:
   - Go to Settings → Pages
   - Select branch: `main`, folder: `/ (root)`
   - Save

3. **Upload files**:
   - Upload all files from this directory
   - Your app will be live at: `https://yourusername.github.io/1f2c/`

## File Structure

```
1f2c/
├── index.html       # Main HTML structure
├── app.js           # Application logic
├── styles.css       # Styling
├── manifest.json    # PWA manifest
├── README.md        # This file
└── icons/          # PWA icons (optional)
    ├── icon-192.png
    └── icon-512.png
```

## How It Works

### Sender (Computer 1)
1. Selects a folder to share (max 10,000 files)
2. App indexes files and calculates SHA-256 hashes (16MB blocks)
3. Generates 8-character share code
4. Waits for receiver connection and approves
5. Sends file manifest and requested blocks

### Receiver (Computer 2)
1. Enters share code from sender
2. Waits for sender approval
3. Selects destination folder
4. Compares local files against manifest
5. Requests only missing/corrupted blocks
6. Verifies integrity using SHA-256 hashes

## Requirements

- **Browser**: Chrome (or Chromium-based browsers like Edge)
- **Network**: Both computers must be online simultaneously
- **Permissions**: File System Access API (automatically prompted)

## Technical Details

- **Signaling**: PeerJS (CDN hosted)
- **Transfer**: WebRTC DataChannels (peer-to-peer)
- **Block Size**: 16MB for hashing, 256KB chunks for transfer
- **Integrity**: SHA-256 hashing per block
- **Cache**: LocalStorage (7-day retention)

## Limitations

- Chrome browser only (v1)
- Maximum 10,000 files per transfer
- No transfer resume after disconnection
- File modified dates not preserved (browser limitation)
- Single sequential transfer (no parallelization)

## Deployment Options

### GitHub Pages (Recommended)
- Free hosting with HTTPS
- Simple setup, no server needed
- URL: `https://yourusername.github.io/1f2c/`

### Netlify
```bash
# Install Netlify CLI
npm install -g netlify-cli

# Deploy
netlify deploy --prod
```

### Vercel
```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel --prod
```

### Cloudflare Pages
1. Connect GitHub repository
2. Build settings: None (static site)
3. Deploy

## Development

To develop locally:

1. **Clone/download files**
2. **Start local server**:
   ```bash
   python -m http.server 8000
   ```
3. **Open in Chrome**: `http://localhost:8000`
4. **Make changes** and refresh browser

## Troubleshooting

### "Failed to connect"
- Check that share code is correct (8 characters, case-insensitive)
- Ensure both computers are online
- Try refreshing both browsers

### "Connection timeout"
- Sender must approve within 60 seconds
- Check network/firewall settings
- Try again with new share code

### "Hash mismatch"
- File may have been modified during transfer
- Connection issue caused data corruption
- Restart transfer to resolve

### "Browser not supported"
- Use Chrome or Edge (Chromium-based)
- Update browser to latest version
- File System Access API required

## Privacy & Security

- **No server storage**: Files transfer directly between computers
- **Encrypted**: WebRTC DataChannels are encrypted by default
- **No tracking**: No analytics or data collection
- **Open source**: Review code for transparency

## License

MIT License - Feel free to use, modify, and distribute.

## Contributing

Contributions welcome! Please submit pull requests or open issues on GitHub.

## Future Enhancements

- Resume capability after disconnection
- Parallel block transfers
- Cross-browser support (Firefox, Safari)
- Mobile app versions
- Bandwidth throttling
- File/folder exclusion patterns

---

**Built with ❤️ using WebRTC, PeerJS, and modern web APIs**
