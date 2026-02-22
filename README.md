# Bay Club Connect Multi-Club Pickleball Court Reservation Helper

Shows pickleball court availability across multiple Bay Club locations and allows booking at any club, even when a different club is set as the default.

## Supported Clubs
- Broadway
- Redwood Shores
- South San Francisco
- Santa Clara

## Installation

1. Install the [Tampermonkey Chrome extension](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
Be aware that Tampermonktoey allows you or someone to install scripts that inject into web pages and alter their behavior. Be careful.
2. Click "Add to Chrome" and confirm
3. Navigate to the [script install URL](https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/loading_script.user.js)
4. Tampermonkey will show an install dialog — click "Install"
5. Done! The script runs automatically on bayclubconnect.com

## Usage
- Navigate to the court booking page as normal, regardless of what club you have selected
- Walk through Pickleball booking. When you get to the players count and duration selector, you can choose the order of club availabilities that will be displayed.
- When you click Next to get to the availability listings, swich to the Hour View. This helper only supports the Hour View.
- Available slots across all clubs will appear automatically.
- Note that you have a time range slider to limit the court availability search to your desired times.
- Note also that you have a checkbox to show clubs only with indoor courts.
- Select any slot, then click NEXT to proceed with booking.
- There's an odd boundary case: if there is no court availability at any time for the default selected club for the day you've selected, this enhanced functionality won't work, so you'll have to pick another default club or another day. You'll see messaging to let you know if you run into this.

## Disabling
- If you're not enjoying this, you can delete the installation from the Tampermonkey extenson's Dashboard UI. If you didn't install TamperMonkey for other reasons, you can just uninstall it entirely.
- You can also temporarily disable this for as long as you like via the Tampermonkey extension's Dashboard UI.

