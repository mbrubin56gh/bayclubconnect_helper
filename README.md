# Bay Club Connect Pickleball Court Reservation Helper

This is a Tampermonkey script to show pickleball court availability across multiple Bay Club locations and allows booking at any club, regarless of which club is set as the default. It has only been tested on desktop Chrome.

## Scope

This is a practical helper for a small friend group, not a fully productized tool. Bay Club can change the SPA behavior at any time, so this script may occasionally need small maintenance updates.

## Supported Clubs
- Redwood Shores
- Broadway
- South San Francisco
- Santa Clara

## Installation

1. Install the [Tampermonkey Chrome extension](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
Be aware that Tampermonkey allows you or someone to install scripts that inject into web pages and alter their behavior. Be careful.
3. Click "Add to Chrome" and confirm.
5. Navigate to the [script install URL](https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/loading_script.user.js)
6. Tampermonkey will show an install dialog. Click "Install".
7. After you install it, click on the puzzle piece in your Chrome 
toolbar, find the Tampermonkey extension listed there, click on the vertical three dots, and click on "Manage Extension".
<img width="617" height="633" alt="Screenshot 2026-02-24 at 3 55 56 PM" src="https://github.com/user-attachments/assets/f440c6f2-1c46-4405-87d2-3426e9a49993" />

8. Make sure the Developer Mode toggle in the top right is switched on, make sure the On button is switched on, and scroll to the Allow User Scripts button and turn that on.
   <img width="1437" height="780" alt="Screenshot 2026-02-24 at 3 56 47 PM" src="https://github.com/user-attachments/assets/d5ea269a-329b-4532-b50c-ef351139fc9f" />
9. If you're still seeing a warning from Tampermonkey that developer mode is not turned on, quit Chrome and restart it.
10. Done! The script runs automatically on [bayclubconnect.com](bayclubconnect.com).
11. It might be convenient to have the Tampermonkey extension pinned. More on that in the [Demonstration](#demonstration) section.

## Usage
- Log in to your account at [bayclubconnect.com](bayclubconnect.com).
- Navigate to the court booking page as normal, regardless of what club you have selected.
- Walk through Pickleball booking. When you get to the typical players count and duration selector, you can choose the order of club availabilities that will be displayed. That display order will be remembered across sessions, and you can always reorder them when you return to this screen.
  
<img width="1170" height="306" alt="Screenshot 2026-02-24 at 4 22 01 PM" src="https://github.com/user-attachments/assets/cab7cb67-eb6a-44b6-9060-622ed156b551" />

- The players count and duration selection you choose will be remembered across booking sessions!
- When you click Next to get to the availability listings, Hour View is now defaulted to instead of Court View. This helper only supports the Hour View, and this helper assumes you prefer it. You can always select Court View manually.
- Available slots across all clubs will appear automatically.
- There is a time range slider to filter the court availabilities displayed to match your specified start and end times, a weather report for each hour on the slider, and a checkbox to show indoor courts only. There's a toggle to switch between BY CLUB and BY TIME sorting: when BY CLUB is selected, you'll see a list of clubs, and under each club, the available slots for that club; when BY TIME is selected, you'll see a list of times, and under each time, the available slots for that time, in club sorted order.


| BY CLUB | BY TIME |
| :---: | :---: |
| <img width="1205" height="723" alt="Screenshot 2026-02-24 at 4 32 41 PM" src="https://github.com/user-attachments/assets/0d881664-b001-4750-859a-20c338307208"/> | <img width="1170" height="717" alt="Screenshot 2026-02-24 at 4 33 16 PM" src="https://github.com/user-attachments/assets/8ce9829a-f6c3-433b-96ab-68e3d992ad4f"/> |

- Unlike the native time slot selector in Hour View, we show all the courts available for a time slot. The native one just shows that some court is available for that time slot and it picks an arbitrary court for you if more than one is available. With this extension, you can choose which one you want to book: click on a card for a time slot with multiple courts listed, and it will expand to allow you to choose your court. That court remains selected until you actually select another court (and not merely expand another card). The court you selected also shows on the bottom information bar.

<img width="1144" height="668" alt="Screenshot 2026-02-24 at 4 33 54 PM" src="https://github.com/user-attachments/assets/58412af9-e4b3-49e9-8dce-c85eaf55c0c7" />

- Cards for times with edge courts are outlined in gold with gold stars: these courts are highlighted because they are less likely to have balls from other courts spray onto them or vice versa). Cards for times with courts that are isolated (e.g. surrounded by a fence) have a heavier gold border and a sparklier star (only Santa Clara has these courts).
- If a time slot is available, but not within the 3 day booking period, it will display, but dimmed with a lock on it (matching the native picker).
<img width="1116" height="639" alt="Screenshot 2026-02-24 at 4 34 34 PM" src="https://github.com/user-attachments/assets/c360b0cf-db61-457f-8c74-40a058ec4f60" />
- Select your time slot and court and then click the button to proceed with booking.

- Once you're on the bookings page, you'll see links to add your booking to Google calendar or to download more generically the calendar entry to add on your own to your calendar application.

<img width="834" height="300" alt="Screenshot 2026-02-25 at 7 20 41 PM" src="https://github.com/user-attachments/assets/f3e2eecb-8cd6-4f08-a4ff-e1622dfdc3af" />

## Debugging

If you hit an issue and want to send diagnostics, the helper includes a hidden debug mode.

- You can enable debug mode from any Bay Club Connect page with either method:
  -- Tap or click the top-left corner of the page five times within four seconds.
  -- Type `debug` within five seconds (while your cursor is not in an input field).
- When debug mode is enabled, you will see a debug panel on both helper screens:
  The Player Count and Duration screen.
  The court availability screen.
- The debug panel includes:
  `Copy logs` to copy a support packet to the clipboard.
  `Email logs` to open a prefilled email draft.
  `Download logs` to save a log file.
  `Clear logs` to reset the stored debug entries.
- You can disable debug mode from the panel by unchecking `Debug mode`.

## Disabling
- If you're not enjoying this or you want to return to the native experience for any reason, you can disable the extension through Tampermonkey's Dashboard. You can also delete the installation of the script from there. If you didn't install TamperMonkey for other reasons, you can just uninstall Tampermonkey entirely by going through Chrome's extension management UI.
- You can also temporarily disable this for as long as you like via the Tampermonkey extension's Dashboard UI.

## Refreshing
- As I fix bugs or release new features, I'll update the version number for the script. But the Tampermonkey extension may take several hours to refresh the script. You can trigger a refresh yourself by clicking on the Utilities menu item for the extension and then clicking on the "Check for userscript updates" entry. Or you can select Dashboard and delete the script and reinstall it.

## Demonstration

Here's a video of manipulating the Tampermonkey extension:

https://github.com/user-attachments/assets/9d8c290a-9de8-43e9-9667-117bb6c05cdd

Here's a video of the extension in action:

https://github.com/user-attachments/assets/358deb10-f6b8-4e3d-913f-6dea0083e576

## Thanks

Weather information is pulled from [Open-Meto](https://open-meteo.com/)
