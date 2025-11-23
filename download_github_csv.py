#!/usr/bin/env python3
"""
Download the complete translation CSV from GitHub for local processing
"""
import urllib.request
import os
import csv

def download_github_csv():
    """Download the complete translation CSV from GitHub"""
    
    # GitHub URL for the complete translation dataset
    github_url = 'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/text/translated_prompts.csv'
    
    # Local destination
    local_file = 'translation_text/complete_translations.csv'
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(local_file), exist_ok=True)
    
    print(f"Downloading complete translation data from GitHub...")
    print(f"Source: {github_url}")
    print(f"Destination: {local_file}")
    
    try:
        # Download the file
        urllib.request.urlretrieve(github_url, local_file)
        
        # Check the file was downloaded successfully
        if os.path.exists(local_file):
            # Read and analyze the CSV structure
            with open(local_file, 'r', encoding='utf-8') as f:
                reader = csv.reader(f)
                headers = next(reader)  # Read header row
                sample_rows = [next(reader) for _ in range(3)]  # Read first 3 data rows
            
            print(f"✅ Download successful!")
            print(f"📊 CSV Structure:")
            print(f"   Columns: {headers}")
            print(f"   Sample data rows: {len(sample_rows)}")
            
            # Show sample data
            for i, row in enumerate(sample_rows):
                print(f"   Row {i+1}: {dict(zip(headers, row))}")
            
            # Count total rows
            with open(local_file, 'r', encoding='utf-8') as f:
                total_rows = sum(1 for _ in f) - 1  # Subtract header row
            
            print(f"📈 Total translation items: {total_rows}")
            
        else:
            print("❌ Download failed - file not found")
            
    except Exception as e:
        print(f"❌ Download error: {e}")

if __name__ == '__main__':
    download_github_csv()