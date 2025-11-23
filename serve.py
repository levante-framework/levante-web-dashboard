#!/usr/bin/env python3
"""
Simple HTTP server for serving the dashboard with proper MIME types
"""
import http.server
import socketserver
import os
import mimetypes

class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='public', **kwargs)
    
    def guess_type(self, path):
        """Override to ensure proper MIME types"""
        mimetype, encoding = mimetypes.guess_type(path)
        if path.endswith('.js'):
            mimetype = 'application/javascript'
        elif path.endswith('.css'):
            mimetype = 'text/css'
        elif path.endswith('.html'):
            mimetype = 'text/html'
        return mimetype, encoding

if __name__ == "__main__":
    PORT = 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("", PORT), CustomHTTPRequestHandler) as httpd:
        print(f"Serving dashboard at http://localhost:{PORT}")
        print("Press Ctrl+C to stop the server")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped") 