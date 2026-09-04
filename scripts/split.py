import os  
import glob  
def run():  
    for f in glob.glob('nse_1month_all.sql.chunk*'): os.remove(f)  
    with open('nse_1month_all.sql', 'r', encoding='utf-8') as f: lines = f.readlines()  
    for i in range(0, len(lines), 10000):  
        with open(f'nse_1month_all.sql.chunk{i//10000+1}.sql', 'w', encoding='utf-8') as c: c.writelines(lines[i:i+10000])  
    with open('upload.bat', 'w') as b:  
        for j in range(1, (len(lines)//10000)+2): b.write(f"call npx wrangler d1 execute site-creator-d1 --remote --file nse_1month_all.sql.chunk{j}.sql -y\n")  
run()  
