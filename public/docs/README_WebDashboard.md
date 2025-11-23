# Levante Pitwall Dashboard (Web Version)

A modern web-based dashboard for comparing and generating TTS audio across multiple languages using PlayHT and ElevenLabs services.

## Features

- **Multi-language Support**: English, Spanish, German, French, and Dutch
- **Dual TTS Services**: PlayHT and ElevenLabs integration
- **Voice Comparison**: Side-by-side comparison of different voices
- **SSML Support**: Advanced speech synthesis markup language editing
- **Real-time Audio Generation**: Generate and play audio instantly
- **Responsive Design**: Works on desktop and mobile devices
- **Voice Filtering**: Female-only voices, excluding advertising voices
- **Cache Management**: Efficient voice caching with refresh capabilities

## Files

- `dashboard.html` - Main HTML interface
- `dashboard.js` - Core JavaScript functionality and API integrations
- `config.js` - Configuration file with language and API settings
- `README_WebDashboard.md` - This documentation file

## Setup

### 1. API Keys

You'll need API keys for both services:

- **PlayHT**: Get your API key and User ID from [PlayHT Dashboard](https://play.ht/)
- **ElevenLabs**: Get your API key from [ElevenLabs Dashboard](https://elevenlabs.io/)

### 2. Configuration

When you first open the dashboard, you'll be prompted to enter your API keys. These are stored locally in your browser's localStorage.

Alternatively, you can set them programmatically:
```javascript
// Set PlayHT credentials
ConfigHelper.setApiKey('playht', 'apiKey', 'your-playht-api-key');
ConfigHelper.setApiKey('playht', 'userId', 'your-playht-user-id');

// Set ElevenLabs credentials
ConfigHelper.setApiKey('elevenlabs', 'apiKey', 'your-elevenlabs-api-key');
```

### 3. Running the Dashboard

1. Serve the files through a web server (due to CORS restrictions)
2. Open `dashboard.html` in your browser
3. Enter your API keys when prompted
4. Start using the dashboard!

#### Simple Local Server Options:

**Python 3:**
```bash
python -m http.server 8000
```

**Node.js (with http-server):**
```bash
npx http-server
```

**PHP:**
```bash
php -S localhost:8000
```

Then open `http://localhost:8000/dashboard.html`

## Usage

### Quick Start

1. **Choose a Language Tab**: Select from English, Spanish, German, French, or Dutch
2. **Search Items**: Use the search box to find specific content
3. **Select Text**: Click on any row to select it and populate the SSML editor
4. **Choose Voices**: Select voices from PlayHT or ElevenLabs dropdowns
5. **Generate Audio**: Click on a voice to generate and play audio
6. **SSML Editing**: Modify text with SSML tags for advanced control

### Voice Comparison

- **PlayHT Voices**: Curated female voices using the PlayDialog engine
- **ElevenLabs Voices**: Professional multilingual voices
- **Automatic Filtering**: Only female voices are shown, advertising voices are excluded
- **Language-Specific**: Voices are filtered by the current language tab

### SSML Features

The dashboard supports common SSML tags:
- `<break time='1.0s'/>` - Add pauses
- `<emphasis>text</emphasis>` - Emphasize text
- `<p>` - Paragraph breaks
- `<phoneme>` - Pronunciation control

## API Integration

### PlayHT Integration

- **API Version**: v2
- **Voice Engine**: PlayDialog (with Play3.0-mini fallback)
- **Features**: Streaming audio generation, voice mapping, error handling
- **Filtering**: Female voices only, language-specific

### ElevenLabs Integration

- **API Version**: v1
- **Model**: eleven_multilingual_v2
- **Features**: High-quality multilingual voices, professional voices
- **Filtering**: Female voices only, professional category

## Technical Details

### Architecture

- **Frontend**: Pure HTML5, CSS3, and JavaScript (ES6+)
- **No Framework Dependencies**: Vanilla JavaScript for maximum compatibility
- **Responsive Design**: CSS Grid and Flexbox for modern layouts
- **Modular Code**: Separate configuration and utility functions

### Browser Compatibility

- **Modern Browsers**: Chrome 60+, Firefox 55+, Safari 11+, Edge 79+
- **Features Used**: Fetch API, async/await, CSS Grid, localStorage
- **Audio**: Web Audio API for playback

### Security Considerations

- **API Keys**: Stored in localStorage (consider more secure options for production)
- **CORS**: Requires proper server setup for API calls
- **Input Validation**: Text and SSML input validation
- **Error Handling**: Comprehensive error handling and user feedback

## Customization

### Adding Languages

Edit `config.js` to add new languages:

```javascript
CONFIG.languages['Italian'] = {
    lang_code: 'it',
    service: 'ElevenLabs',
    voice: 'Italian Voice Name',
    display_name: 'Italian'
};
```

### Voice Curation

Modify the `curatedVoices` section in `config.js` to change voice selections:

```javascript
CONFIG.curatedVoices.playht['it'] = [
    'Italian_Voice_1',
    'Italian_Voice_2'
];
```

### Styling

The dashboard uses CSS custom properties for easy theming. Modify the CSS variables in `dashboard.html`:

```css
:root {
    --primary-color: #4facfe;
    --secondary-color: #00f2fe;
    --accent-color: #667eea;
}
```

## Troubleshooting

### Common Issues

1. **API Keys Not Working**: Ensure keys are correctly entered and have proper permissions
2. **CORS Errors**: Serve files through a web server, not file:// protocol
3. **No Voices Loading**: Check API keys and network connectivity
4. **Audio Not Playing**: Ensure browser allows audio playback (user interaction required)

### Debug Mode

Open browser developer tools (F12) to see detailed logging and error messages.

### Voice Cache Issues

If voices aren't updating:
1. Click "Refresh Voices" button
2. Clear browser cache
3. Check API key validity

## Performance

- **Voice Caching**: Voices are cached for 24 hours
- **Audio Streaming**: Direct audio streaming from APIs
- **Lazy Loading**: Voices loaded only when needed
- **Debounced Search**: Search input is debounced for performance

## Limitations

- **Browser-Based**: Requires modern web browser
- **API Dependent**: Requires active internet connection
- **Rate Limits**: Subject to API rate limits
- **Storage**: Uses localStorage for settings (limited storage)

## Future Enhancements

- **Offline Support**: Service worker for offline functionality
- **Batch Processing**: Multiple audio generation
- **Export Features**: Download generated audio files
- **Advanced Analytics**: Usage statistics and voice performance metrics
- **User Accounts**: Cloud-based settings synchronization

## Support

For issues or questions:
1. Check the browser console for error messages
2. Verify API key configuration
3. Ensure proper web server setup
4. Check network connectivity

## License

This project is part of the Levante framework for educational technology research.
