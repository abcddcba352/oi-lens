import os
import glob

def chunk_sql_file(input_file, chunk_size=500):
    if not os.path.exists(input_file):
        print(f"File {input_file} not found.")
        return

    print("Reading SQL statements...")
    
    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    total_lines = len(lines)
    print(f"Splitting {total_lines} lines into ultra-safe chunks of {chunk_size}...")

    # Clean up old chunks
    for f in glob.glob(f"{input_file}.chunk*"):
        os.remove(f)

    chunk_num = 1
    chunk_files = []
    
    for i in range(0, total_lines, chunk_size):
        chunk_lines = lines[i:i+chunk_size]
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
    chunk_sql_file("nse_1month_all.sql")
