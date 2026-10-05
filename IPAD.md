# Putting the concession app on an iPad

The iPad version is a **standalone web app**. Once installed it runs with no wifi or cell signal, and all data is stored
on the iPad. The files in `ipad-app/` only need to be hosted somewhere over **HTTPS** once, so Safari will let you install it.
The files contain no club data, so the hosting can be public.

Rebuild the folder any time with `python3 build_ipad.py` (run it again after any change to `index.html` or `pwa/`).

## 1. Host `ipad-app/` over HTTPS (pick one)

### A. Your droplet (monitor.itspec.biz:8081)

On the Mac, make a bundle:

```bash
cd "/Users/tj/Documents/Claude Code/booster-concessions"
COPYFILE_DISABLE=1 tar czf concessions-ipad.tgz -C ipad-app .
scp concessions-ipad.tgz <you>@164.92.94.242:/tmp/
```

On the server:

```bash
sudo mkdir -p /var/www/concessions
sudo tar xzf /tmp/concessions-ipad.tgz -C /var/www/concessions --no-same-owner
```

Add this inside the existing `server { listen 8081 ssl; ... }` block (next to the `location /` that proxies the toolbox), then reload:

```nginx
    location /concessions/ {
        alias /var/www/concessions/;
        index index.html;
        add_header Cache-Control "no-cache";
    }
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The app is then at **https://monitor.itspec.biz:8081/concessions/**. To ship an update, repeat the `tar`/`scp` steps. No nginx change is needed. The iPad picks up the new version the next time it's opened with a connection.

### B. GitHub Pages / Netlify / Cloudflare Pages
Upload the contents of `ipad-app/` to a repo or drop the folder into the host. Use the HTTPS address it gives you.

## 2. Install on the iPad

1. Open the HTTPS address in **Safari** and let it finish loading.
2. Tap **Share → Add to Home Screen → Add**.
3. **Open the app from the new home-screen icon**, not from Safari. The icon and Safari keep separate data on iOS.
4. Go to **Data & Help**. It should say `storage: this iPad (IndexedDB)`.
5. Try **Load demo data** to practice, then **Erase everything** before game day.
6. Turn the iPad's wifi off, force-quit the app and reopen it to confirm it still launches offline.

## 3. Keeping the data safe

- Data lives only on this iPad. Deleting the icon or erasing the iPad deletes it.
- **Data & Help → Back up now** opens the iPad share sheet. Save to Files/iCloud Drive, AirDrop it, or email it to the treasurer.
  The app shows a reminder on the Register when there are sales that haven't been backed up in a week.
- **Restore from backup** brings everything back on a new or replacement iPad.
- Already tracking on the laptop version? Convert it and restore it on the iPad:
  `python3 db_to_json.py data/concessions.db > backup.json`, AirDrop `backup.json` to the iPad, then Restore.

## Updating an iPad that's already installed

Rebuild (`python3 build_ipad.py`), push the new `ipad-app` files to GitHub (see "Shipping updates"), wait a minute, then open the app on the iPad
with a connection. Close it fully and reopen if it still shows the old version (Data & Help shows the version). Your data is kept.
Back up first if you want a safety net.

## Notes
- Multiple iPads each keep their own separate data. To combine them, you'd want the hosted-on-the-droplet design instead.
- Reports and CSV exports run on the iPad. CSVs open in Numbers or Excel from the share sheet.
- Tip: turn on Guided Access (Settings → Accessibility) to keep helpers inside the app during an event.
