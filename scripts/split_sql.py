import os

def dedup_and_chunk(input_file, chunk_size=5000):
    if not os.path.exists(input_file):
        print(f"File {input_file} not found.")
        return

    print("Reading and deduplicating SQL statements (this removes overlapping ATR warmups)...")
    
    unique_lines = []
    seen = set()
    
    with open(input_file, 'r', encoding='utf-8') as f:
        for line in f:
            # We use the statement prefix up to VALUES as a fast deduplicator for ON CONFLICT rows
            # Or just the entire line since they should be identical except maybe for ATR drift.
            # Actually, to be perfectly safe, let's parse the ID from the statement if it's an insert.
            
            # Simple hash of the line to remove exact duplicates:
            # Wait, ATR values might drift slightly depending on the calculation window. 
            # Let's deduplicate by the unique ID inside the INSERT statement.
            
            # Example: INSERT INTO market_sessions (id, ... VALUES ('NSE:20MICRONS-EQ:2026-07-13', ...
            
            parts = line.split("VALUES ('")
            if len(parts) > 1:
                row_id = parts[1].split("'")[0]
                table = line.split("INTO ")[1].split(" ")[0]
                unique_key = f"{table}:{row_id}"
                
                if unique_key not in seen:
                    seen.add(unique_key)
                    unique_lines.append(line)
            else:
                if line not in seen:
                    seen.add(line)
                    unique_lines.append(line)

    total_lines = len(unique_lines)
    print(f"Removed massive amount of duplicates! Shrunk from hundreds of thousands to {total_lines} unique statements.")
    print(f"Splitting {total_lines} lines into chunks of {chunk_size}...")

    # Clean up old chunks
    import glob
    for f in glob.glob(f"{input_file}.chunk*"):
        os.remove(f)

    chunk_num = 1
    chunk_files = []
    
    for i in range(0, total_lines, chunk_size):
        chunk_lines = unique_lines[i:i+chunk_size]
        chunk_name = f"{input_file}.chunk{chunk_num}.sql"
        
        with open(chunk_name, 'w', encoding='utf-8') as chunk_file:
            chunk_file.writelines(chunk_lines)
            
        chunk_files.append(chunk_name)
        chunk_num += 1
        
    # Generate batch file
    bat_filename = "upload_chunks.bat"
    with open(bat_filename, 'w', encoding='utf-8') as bat_file:
        bat_file.write("@echo off\n")
        bat_file.write("echo Starting D1 uploads...\n")
        for chunk in chunk_files:
            bat_file.write(f"echo Uploading {chunk}...\n")
            bat_file.write(f"call npx wrangler d1 execute site-creator-d1 --remote --file {chunk} -y\n")
            bat_file.write(f"if %errorlevel% neq 0 echo Error uploading {chunk} & exit /b %errorlevel%\n")
        bat_file.write("echo All chunks uploaded successfully!\n")
        
    print(f"\nDone! Created an updated batch file to automatically upload {len(chunk_files)} chunks.")

if __name__ == "__main__":
    dedup_and_chunk("nse_1month_all.sql")
