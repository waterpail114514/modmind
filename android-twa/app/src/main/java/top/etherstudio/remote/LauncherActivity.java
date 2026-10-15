package top.etherstudio.remote;

import android.net.Uri;
import android.os.Bundle;

/**
 * Opens the Ether Studio remote control page inside a Trusted Web Activity.
 *
 * The launch URL lives in a resource so the shell never needs to be rebuilt for
 * path changes on the site; only this constant would need updating if the
 * origin itself ever moves (which would also require new assetlinks.json).
 */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    private static final Uri LAUNCH_URL = Uri.parse("https://ether-studio.top/");

    @Override
    public Uri getLaunchingUrl() {
        return LAUNCH_URL;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
