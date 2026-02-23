# Bay Club Connect Pickleball Court Reservation Helper

This is a Tampermonkey script to show pickleball court availability across multiple Bay Club locations and allows booking at any club, regarless of which club is set as the default. It has only been tested on desktop Chrome.

## Supported Clubs
- Redwood Shores
- Broadway
- South San Francisco
- Santa Clara

## Installation

1. Install the [Tampermonkey Chrome extension](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
Be aware that Tampermonkey allows you or someone to install scripts that inject into web pages and alter their behavior. Be careful.
2. Click "Add to Chrome" and confirm.
3. Navigate to the [script install URL](https://raw.githubusercontent.com/mbrubin56gh/bayclubconnect_helper/master/loading_script.user.js)
4. Tampermonkey will show an install dialog — click "Install"
5. Done! The script runs automatically on [bayclubconnect.com](bayclubconnect.com).
6. It might be convenient to have the Tampermonkey extension pinned. More on that in the [Demonstration](#demonstration) section.

## Usage
- Log in to your account at [bayclubconnect.com](bayclubconnect.com).
- Navigate to the court booking page as normal, regardless of what club you have selected.
- Walk through Pickleball booking. When you get to the typical players count and duration selector, you can choose the order of club availabilities that will be displayed. That display order will be remembered across sessions, and you can always reorder them when you return to this screen.
- The players count and duration selection you choose will be remembered across booking sessions!
- When you click Next to get to the availability listings, Hour View is now defaulted to instead of Court View. This helper only supports the Hour View, and this helper assumes you prefer it. You can always select Court View manually.
- Available slots across all clubs will appear automatically.
- Note that you have a time range slider to filter the court availabilities displayed to match your specified start and end times.
- Note also that you have a checkbox to show clubs only with indoor courts or not. 
- There's some weather prediction built in: an icon will show indicating level of rain, cloudiness, or sun. If >10% chaince of rain is predicted, that percentage is shown next to the rain cloud.
- Unlike the native time slot selector in Hour View, we show all the courts available for a time slot. The native one just shows that some court is available for that time slot and it picks an arbitrary court for you if more than one is available. With this extension, you can choose which one you want to book: click on a card for a time slot with multiple courts listed, and it will expand to allow you to choose your court. That court remains selected until you actually select another court (and not merely expand another card). The court you selected also shows on the bottom information bar.
- Cards for times with edge courts are outlined in gold with gold stars: these courts are highlighted because they are less likely to have balls from other courts spray onto them or vice versa).
- If a time slot is available, but not within the 3 day booking period, it will display, but dimmed with a lock on it (matching the native picker).
- Select your time slot and court and then click the button to proceed with booking.

## Disabling
- If you're not enjoying this or you want to return to the native experience for any reason, you can disable the extension through Tampermonkey's Dashboard. You can also delete the installation of the script from there. If you didn't install TamperMonkey for other reasons, you can just uninstall Tampermonkey entirely by going through Chrome's extension management UI.
- You can also temporarily disable this for as long as you like via the Tampermonkey extension's Dashboard UI.

## Refreshing
- As I fix bugs or release new features, I'll update the version number for the script. But the Tampermonkey extension may take several hours to refresh the script. You can trigger a refresh yourself by clicking on the Utilities menu item for the extension and then clicking on the Check for userscript updates entry. Or you can select Dashboard and delete the script and reinstall it.

## Demonstration

Here's a video of manipulating the Tampermonkey extension:

Here's a video of the extension in action:

