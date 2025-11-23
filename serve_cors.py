#!/usr/bin/env python3
"""
CORS Proxy Server for PlayHT and Google Translate APIs
This server acts as a proxy to handle CORS issues with API calls from the browser
Supports:
- PlayHT API for text-to-speech generation
- Google Translate API for translation validation and back-translation
"""
import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import os
from urllib.error import HTTPError

class CORSProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='public', **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-USER-ID, AUTHORIZATION')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def do_GET(self):
        # Handle ElevenLabs voices endpoint
        if self.path.startswith('/proxy/elevenlabs/voices'):
            self.handle_elevenlabs_voices()
        else:
            super().do_GET()
    
    def do_POST(self):
        # Handle PlayHT API proxy requests
        if self.path.startswith('/proxy/playht'):
            self.handle_playht_proxy()
        # Handle ElevenLabs API proxy requests
        elif self.path.startswith('/proxy/elevenlabs'):
            self.handle_elevenlabs_proxy()
        # Handle Google Translate API proxy requests
        elif self.path.startswith('/proxy/translate'):
            self.handle_translate_proxy()
        else:
            # SimpleHTTPRequestHandler doesn't support POST by default
            self.send_response(405)  # Method Not Allowed
            self.send_header('Allow', 'GET, HEAD, OPTIONS')
            self.end_headers()
            self.wfile.write(b'POST method not supported for this endpoint')
    
    def handle_playht_proxy(self):
        try:
            # Read the request body
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            # Get headers from the original request
            auth_header = self.headers.get('AUTHORIZATION')
            user_id_header = self.headers.get('X-USER-ID')
            
            if not auth_header or not user_id_header:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Missing PlayHT credentials')
                return
            
            # Create the request to PlayHT API
            playht_url = 'https://api.play.ht/api/v2/tts/stream'
            req = urllib.request.Request(
                playht_url,
                data=post_data,
                headers={
                    'Content-Type': 'application/json',
                    'AUTHORIZATION': auth_header,
                    'X-USER-ID': user_id_header,
                    'Accept': 'audio/mpeg',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            )
            
            # Make the request to PlayHT
            with urllib.request.urlopen(req) as response:
                # Send the response back to the client
                self.send_response(response.getcode())
                
                # Copy relevant headers
                for header, value in response.headers.items():
                    if header.lower() not in ['connection', 'transfer-encoding']:
                        self.send_header(header, value)
                
                self.end_headers()
                
                # Copy the response body
                self.wfile.write(response.read())
                
        except HTTPError as e:
            print(f"PlayHT API error: {e.code} - {e.reason}")
            self.send_response(e.code)
            self.end_headers()
            error_response = e.read() if hasattr(e, 'read') else str(e).encode()
            self.wfile.write(error_response)
        except Exception as e:
            print(f"Proxy error: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Proxy error: {str(e)}".encode())
    
    def handle_elevenlabs_proxy(self):
        try:
            # Read the request body
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            # Get API key from headers
            api_key = self.headers.get('X-API-KEY')
            if not api_key:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Missing ElevenLabs API key')
                return
            
            # Parse the voice ID from the URL path
            # Expected path: /proxy/elevenlabs/{voice_id}
            path_parts = self.path.split('/')
            if len(path_parts) < 4:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Voice ID required in URL path')
                return
                
            voice_id = path_parts[3]
            
            # Debug the request
            print(f"🔍 ElevenLabs request: voice_id={voice_id}")
            print(f"🔍 ElevenLabs request body: {post_data.decode('utf-8', errors='replace')}")
            
            # Create the request to ElevenLabs API
            elevenlabs_url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}'
            req = urllib.request.Request(
                elevenlabs_url,
                data=post_data,
                headers={
                    'Content-Type': 'application/json',
                    'xi-api-key': api_key,
                    'Accept': 'audio/mpeg',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            )
            
            # Make the request to ElevenLabs
            with urllib.request.urlopen(req) as response:
                # Send the response back to the client
                self.send_response(response.getcode())
                
                # Copy relevant headers
                for header, value in response.headers.items():
                    if header.lower() not in ['connection', 'transfer-encoding']:
                        self.send_header(header, value)
                
                self.end_headers()
                
                # Copy the response body
                self.wfile.write(response.read())
                
        except HTTPError as e:
            error_body = ""
            try:
                if hasattr(e, 'read'):
                    error_body = e.read().decode('utf-8', errors='replace')
                print(f"ElevenLabs API error: {e.code} - {e.reason}")
                print(f"ElevenLabs error body: {error_body}")
            except Exception as decode_error:
                print(f"Error reading ElevenLabs error response: {decode_error}")
            
            self.send_response(e.code)
            self.end_headers()
            error_response = error_body.encode('utf-8') if error_body else str(e).encode()
            self.wfile.write(error_response)
        except Exception as e:
            print(f"ElevenLabs proxy error: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Proxy error: {str(e)}".encode())
    
    def handle_elevenlabs_voices(self):
        try:
            # Get API key from headers
            api_key = self.headers.get('X-API-KEY')
            if not api_key:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Missing ElevenLabs API key')
                return
            
            # Create the request to ElevenLabs voices API
            elevenlabs_url = 'https://api.elevenlabs.io/v1/voices'
            req = urllib.request.Request(
                elevenlabs_url,
                headers={
                    'xi-api-key': api_key,
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            )
            
            # Make the request to ElevenLabs
            with urllib.request.urlopen(req) as response:
                # Send the response back to the client
                self.send_response(response.getcode())
                
                # Copy relevant headers
                for header, value in response.headers.items():
                    if header.lower() not in ['connection', 'transfer-encoding']:
                        self.send_header(header, value)
                
                self.end_headers()
                
                # Copy the response body
                self.wfile.write(response.read())
                
        except HTTPError as e:
            print(f"ElevenLabs voices API error: {e.code} - {e.reason}")
            self.send_response(e.code)
            self.end_headers()
            error_response = e.read() if hasattr(e, 'read') else str(e).encode()
            self.wfile.write(error_response)
        except Exception as e:
            print(f"ElevenLabs voices proxy error: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Proxy error: {str(e)}".encode())
    
    def handle_translate_proxy(self):
        try:
            # Read the request body
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            request_data = json.loads(post_data.decode('utf-8'))
            
            # Get API key from headers
            api_key = self.headers.get('X-API-KEY')
            if not api_key:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Missing Google Translate API key')
                return
            
            # Extract request parameters
            text = request_data.get('text', '')
            source_lang = request_data.get('source', 'en')
            target_lang = request_data.get('target', 'es')
            operation = request_data.get('operation', 'translate')  # 'translate' or 'back_translate'
            
            if not text:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'Missing text to translate')
                return
            
            # Prepare Google Translate API request
            translate_url = f'https://translation.googleapis.com/language/translate/v2?key={api_key}'
            
            # For back-translation, we keep the languages as intended:
            # source_lang = the language of the text we're translating FROM
            # target_lang = the language we want to translate TO
            # No reversal needed - we want Spanish->English for back-translation
            
            translate_data = {
                'q': text,
                'source': source_lang,
                'target': target_lang,
                'format': 'text'
            }
            
            # Create the request to Google Translate API
            req = urllib.request.Request(
                translate_url,
                data=json.dumps(translate_data).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                }
            )
            
            # Make the request to Google Translate
            with urllib.request.urlopen(req) as response:
                response_data = json.loads(response.read().decode('utf-8'))
                
                # Extract translated text
                if 'data' in response_data and 'translations' in response_data['data']:
                    translated_text = response_data['data']['translations'][0]['translatedText']
                    
                    # Prepare response
                    result = {
                        'original': text,
                        'translated': translated_text,
                        'source_lang': source_lang,
                        'target_lang': target_lang,
                        'operation': operation
                    }
                    
                    # For back-translation, add similarity calculation and proper text structure
                    if operation == 'back_translate':
                        original_english = request_data.get('original_text', '')
                        
                        # Basic similarity calculation (can be enhanced later)
                        original_words = set(original_english.lower().split())
                        back_translated_words = set(translated_text.lower().split())
                        
                        if original_words:
                            similarity = len(original_words & back_translated_words) / len(original_words)
                            result['similarity_score'] = round(similarity * 100, 1)
                        else:
                            result['similarity_score'] = 0
                        
                        # Update result structure for back-translation display
                        result.update({
                            'original_english': original_english,  # Original English text
                            'source_text': text,  # The translated text that was sent back
                            'back_translated': translated_text,  # Back-translated English
                        })
                        
                        # Debug logging
                        print(f"🔍 Back-translation processed:")
                        print(f"   Original English: {original_english[:50]}...")
                        print(f"   Source text (Spanish): {text[:50]}...")
                        print(f"   Back-translated: {translated_text[:50]}...")
                        print(f"   Similarity: {result['similarity_score']}%")
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                else:
                    raise Exception("Invalid response from Google Translate API")
                    
        except HTTPError as e:
            print(f"Google Translate API error: {e.code} - {e.reason}")
            self.send_response(e.code)
            self.end_headers()
            error_response = e.read() if hasattr(e, 'read') else str(e).encode()
            self.wfile.write(error_response)
        except Exception as e:
            print(f"Translation proxy error: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Translation proxy error: {str(e)}".encode())

if __name__ == "__main__":
    PORT = 8001
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("", PORT), CORSProxyHandler) as httpd:
        print(f"CORS Proxy server running at http://localhost:{PORT}")
        print("Available endpoints:")
        print("  - /proxy/playht            : PlayHT API for text-to-speech")
        print("  - /proxy/elevenlabs        : ElevenLabs API for text-to-speech")
        print("  - /proxy/elevenlabs/voices : ElevenLabs voices list")
        print("  - /proxy/translate         : Google Translate API for validation")
        print("  - Static files served from public/ directory")
        print("Press Ctrl+C to stop the server")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped") 