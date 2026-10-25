# Run BeeHave yourself on this Mac

The current folder is `/path/to/BeeHave`. It was moved from `Documents/ChatGPT/BeeHave`.

## 1. Start the web app and backend

Open **Terminal** (Command+Space, type Terminal, press Return). Paste:

```sh
cd "/path/to/BeeHave"
npm run dev
```

Keep this tab open. Wait for both messages:

- `Local: http://127.0.0.1:5173/`
- `BeeHave API listening on port 3001`

Open `http://127.0.0.1:5173` in your browser to use the web app.

## 2. Start the iPhone simulator

Press **Command+T** to open a second Terminal tab. Paste:

```sh
cd "/path/to/BeeHave"
npm run ios
```

The iPhone simulator and Expo Go should open automatically. Leave this tab running too. The first launch may take a little longer while JavaScript is bundled.

PostgreSQL is already installed and running on this Mac. The required npm packages are already installed. You do not need to reinstall either each time.

## 3. Stop the app

Press **Control+C** in each running Terminal tab. This stops the development servers; it does not erase your PostgreSQL data.

## If something goes wrong

- **Port already in use:** another copy is running. Stop that copy with Control+C before restarting. Do not choose another Metro port unless you intend to run a second app.
- **Simulator cannot connect:** keep both Terminal tabs running, then press `r` in the Expo tab to reload.
- **Old paths or a stale screen after moving the folder:** stop the Expo tab, then run `npm run ios -- --clear` from the current project folder.
- **PostgreSQL connection refused:** run `brew services start postgresql@16`, then start `npm run dev` again.
- **Cannot find package.json:** the Terminal is in the wrong folder. Run the `cd` command above first.

For a physical iPhone, the API address must use your Mac’s LAN IP; the `npm run ios` shortcut above is configured for the simulator.
