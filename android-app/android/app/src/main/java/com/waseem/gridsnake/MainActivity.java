package com.waseem.gridsnake;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * The game is a web page; this activity only adds Android's Back button behaviour.
 * Back asks the page first (window.__androidBack closes a dialog, or leaves a run for the menu).
 * Only when the page says "nothing to close" does the app move to the background.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView web = getBridge() == null ? null : getBridge().getWebView();
                if (web == null) { moveTaskToBack(true); return; }
                web.evaluateJavascript(
                    "(function(){try{return window.__androidBack?window.__androidBack():false;}catch(e){return false;}})()",
                    value -> { if (!"true".equals(value)) moveTaskToBack(true); });
            }
        });
    }
}
