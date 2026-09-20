package com.example.demo.edge;

import java.util.function.Supplier;

/**
 * Class javadoc mentioning braces { and } on purpose, plus a fake signature:
 * public class NotReal { void nope() {
 */
public class StructuralEdgeCases {

    private static final String BRACEY = "if (x) { return; } // not real {";

    public void runIt() {
        Runnable r = new Runnable() {
            @Override
            public void run() {
                helper();
            }
        };
        r.run();
        helper();
    }

    private void helper() {
        // trailing brace in a comment }{
        String text = """
                SELECT * FROM t WHERE id = {1}
                """;
        Supplier<String> supplier = () -> "a" + text;
        supplier.get();
    }

    public static class Inner {
        public void doInner() {
            helper();
        }

        private void helper() {
        }
    }

    public int[] counts = new int[] {1, 2, 3};

    public StructuralEdgeCases() {
        counts = new int[] {4};
    }
}
