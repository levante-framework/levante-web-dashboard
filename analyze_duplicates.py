#!/usr/bin/env python3

import pandas as pd
from collections import Counter

def analyze_translation_data():
    """Analyze the translation CSV for duplicates and data issues"""
    
    try:
        # Read the downloaded CSV
        csv_path = 'translation_text/complete_translations.csv'
        df = pd.read_csv(csv_path)
        
        print("🔍 Translation Data Analysis")
        print("=" * 50)
        
        # Basic info
        print(f"📊 Total rows: {len(df)}")
        print(f"📋 Columns: {list(df.columns)}")
        print()
        
        # Check for duplicated identifiers
        print("🔑 Identifier Analysis:")
        identifier_counts = df['identifier'].value_counts()
        duplicates = identifier_counts[identifier_counts > 1]
        
        if len(duplicates) > 0:
            print(f"❌ Found {len(duplicates)} duplicated identifiers:")
            for identifier, count in duplicates.head(10).items():
                print(f"   '{identifier}': {count} times")
            print()
            
            # Show examples of duplicated rows
            print("📋 Example duplicate rows:")
            first_duplicate = duplicates.index[0]
            duplicate_rows = df[df['identifier'] == first_duplicate]
            print(duplicate_rows[['identifier', 'labels', 'en', 'de']].to_string(index=False))
        else:
            print("✅ No duplicated identifiers found")
        print()
        
        # Check for empty/null values in German column
        print("🇩🇪 German Translation Analysis:")
        print(f"   Total rows: {len(df)}")
        print(f"   Has German text: {df['de'].notna().sum()}")
        print(f"   Empty German: {df['de'].isna().sum()}")
        print(f"   Blank German: {(df['de'] == '').sum()}")
        print()
        
        # Check each language column
        languages = ['en', 'es-CO', 'de', 'fr-CA', 'nl']
        print("🌍 Language Coverage:")
        for lang in languages:
            if lang in df.columns:
                filled = df[lang].notna() & (df[lang] != '')
                print(f"   {lang:6}: {filled.sum():4d} / {len(df)} ({filled.sum()/len(df)*100:.1f}%)")
        print()
        
        # Check for potential data loading issues
        print("🔍 Potential Issues:")
        
        # Look for rows that might be getting duplicated in processing
        labels_counts = df['labels'].value_counts()
        print(f"   Task categories: {len(labels_counts)}")
        print(f"   Largest category: '{labels_counts.index[0]}' with {labels_counts.iloc[0]} items")
        
        return {
            'total_rows': len(df),
            'duplicated_identifiers': len(duplicates),
            'german_translations': df['de'].notna().sum(),
            'unique_identifiers': df['identifier'].nunique()
        }
        
    except Exception as e:
        print(f"❌ Error reading CSV: {e}")
        return None

if __name__ == "__main__":
    results = analyze_translation_data()
    if results:
        print("\n📈 Summary:")
        print(f"   Expected German items: {results['german_translations']}")
        print(f"   Your dashboard shows: 1560 (almost double!)")
        print(f"   This suggests data duplication in the dashboard loading logic")